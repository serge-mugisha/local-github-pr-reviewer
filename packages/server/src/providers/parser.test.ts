import { describe, it, expect } from "vitest";
import { parseReviewOutput, parseRevalidateOutput, ReviewOutputParseError } from "./parser.js";

describe("parseReviewOutput", () => {
  it("extracts comments from a fenced json block at the end of the response", () => {
    const raw = `
Some narration first.

\`\`\`json
{
  "summary": "Looks mostly fine, one concern.",
  "comments": [
    { "path": "src/foo.ts", "line": 12, "side": "RIGHT", "severity": "concern",
      "body": "This drops the error." }
  ]
}
\`\`\`
`;
    const out = parseReviewOutput(raw);
    expect(out.summary).toBe("Looks mostly fine, one concern.");
    expect(out.comments).toHaveLength(1);
    expect(out.comments[0]).toMatchObject({
      path: "src/foo.ts",
      line: 12,
      side: "RIGHT",
      severity: "concern",
    });
  });

  it("survives a fenced code snippet inside a comment body", () => {
    const raw = `
Findings below.

\`\`\`json
{
  "summary": "One finding with a suggested patch.",
  "comments": [
    { "path": "src/foo.ts", "line": 3, "side": "RIGHT", "severity": "concern",
      "body": "Wrap it:\\n\\n\`\`\`python\\ndef _all():\\n    pass\\n\`\`\`" }
  ]
}
\`\`\`
`;
    const out = parseReviewOutput(raw);
    expect(out.summary).toBe("One finding with a suggested patch.");
    expect(out.comments).toHaveLength(1);
  });

  it("does not mistake a fenced JSON suggestion inside a comment for the review envelope", () => {
    const suggestedJson = JSON.stringify({ sample: true });
    const payload = JSON.stringify(
      {
        summary: "The outer review remains authoritative.",
        comments: [
          {
            path: "src/foo.ts",
            line: 3,
            side: "RIGHT",
            severity: "concern",
            body: `Use this:\n\n\`\`\`json\n${suggestedJson}\n\`\`\``,
          },
        ],
      },
      null,
      2,
    );
    const out = parseReviewOutput(`\`\`\`json\n${payload}\n\`\`\``);
    expect(out.summary).toBe("The outer review remains authoritative.");
    expect(out.comments[0]?.body).toContain(suggestedJson);
  });

  it("defaults side to RIGHT when omitted and a path is present", () => {
    const raw =
      '```json\n{"summary":"One nit.","comments":[{"path":"a.ts","line":1,"severity":"nit","body":"x"}]}\n```';
    const out = parseReviewOutput(raw);
    expect(out.comments[0]!.side).toBe("RIGHT");
  });

  it("uses the LAST json block when multiple are present", () => {
    const raw = `
\`\`\`json
{"summary":"ignored draft","comments":[{"path":"a.ts","line":1,"severity":"nit","body":"old"}]}
\`\`\`

revised version below

\`\`\`json
{"summary":"final","comments":[{"path":"b.ts","line":2,"severity":"concern","body":"new"}]}
\`\`\`
`;
    const out = parseReviewOutput(raw);
    expect(out.summary).toBe("final");
    expect(out.comments[0]!.body).toBe("new");
  });

  it("rejects an earlier valid draft when the final fenced revision is malformed", () => {
    const raw = `
\`\`\`json
{"summary":"superseded draft","comments":[]}
\`\`\`

revised version below

\`\`\`json
{"summary":"truncated final","comments":[]
\`\`\`
`;
    expect(() => parseReviewOutput(raw)).toThrow(ReviewOutputParseError);
  });

  it("accepts a valid final revision after an earlier malformed fenced draft", () => {
    const raw = `
\`\`\`json
{"summary":"truncated draft","comments":[]
\`\`\`

corrected version below

\`\`\`json
{"summary":"valid final","comments":[]}
\`\`\`
`;
    expect(parseReviewOutput(raw)).toEqual({ summary: "valid final", comments: [] });
  });

  it("fails explicitly when no json block is present", () => {
    expect(() => parseReviewOutput("Just a freeform response, no JSON at all.")).toThrow(
      ReviewOutputParseError,
    );
  });

  it("fails explicitly on malformed JSON and retains recovery diagnostics", () => {
    const raw = '```json\n{ "summary": "broken", "comments": [\n```';
    let caught: unknown;
    try {
      parseReviewOutput(raw, ["session-1"]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReviewOutputParseError);
    expect(caught).toMatchObject({ rawOutput: raw, sessionIds: ["session-1"] });
  });

  it("rejects an empty object instead of treating it as a clean review", () => {
    expect(() => parseReviewOutput("```json\n{}\n```")).toThrow(ReviewOutputParseError);
  });

  it("requires a non-empty summary only when the comments array is empty", () => {
    expect(() => parseReviewOutput('```json\n{"summary":"","comments":[]}\n```')).toThrow(
      ReviewOutputParseError,
    );
    expect(parseReviewOutput('```json\n{"summary":"No findings.","comments":[]}\n```')).toEqual({
      summary: "No findings.",
      comments: [],
    });
    expect(parseReviewOutput('```json\n{"summary":"No findings."}\n```')).toEqual({
      summary: "No findings.",
      comments: [],
    });
    const finding = parseReviewOutput(
      '```json\n{"summary":"","comments":[{"path":"a.ts","line":1,"body":"Real finding"}]}\n```',
    );
    expect(finding.summary).toBe("Review completed with 1 finding.");
    expect(finding.comments).toHaveLength(1);
  });

  it("falls back to extracting a raw {…} blob when no fence is present", () => {
    const raw =
      'thinking… {"summary":"raw","comments":[{"path":"a.ts","line":3,"severity":"concern","body":"q"}]}';
    const out = parseReviewOutput(raw);
    expect(out.summary).toBe("raw");
    expect(out.comments).toHaveLength(1);
  });
});

describe("parseRevalidateOutput", () => {
  it("returns the resolved flag and explanation", () => {
    const raw = '```json\n{"resolved": true, "explanation": "Fixed in src/foo.ts:42."}\n```';
    const out = parseRevalidateOutput(raw);
    expect(out).toEqual({ resolved: true, explanation: "Fixed in src/foo.ts:42." });
  });

  it("returns null when no parseable block is present", () => {
    expect(parseRevalidateOutput("nothing here")).toBeNull();
  });
});
