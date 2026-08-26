import { z } from "zod";
import type { ReviewComment } from "./types.js";

const CommentSchema = z.object({
  path: z.string().nullable().optional(),
  line: z.number().int().nullable().optional(),
  side: z.enum(["LEFT", "RIGHT"]).nullable().optional(),
  severity: z.enum(["blocker", "concern", "nit", "praise"]).default("concern"),
  body: z.string().min(1),
});

const ReviewSchema = z
  .object({
    summary: z.string().default(""),
    comments: z.array(CommentSchema).default([]),
  })
  .superRefine((review, ctx) => {
    if (review.summary.trim() || review.comments.length > 0) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["summary"],
      message: "A zero-finding review requires a non-empty summary.",
    });
  });

const RevalidateSchema = z.object({
  resolved: z.boolean(),
  explanation: z.string().default(""),
});

// Match only actual Markdown fence lines. A review comment body can contain
// the encoded characters ```json, but inside the outer JSON string they are
// not on a physical line of provider output and must not become candidates.
const JSON_FENCE_MARKER = /^[\t ]*```json[\t ]*\r?$/gim;
const CLOSING_FENCE_MARKER = /^[\t ]*```[\t ]*\r?$/gm;

export class ReviewOutputParseError extends Error {
  readonly rawOutput: string;
  readonly sessionIds: string[];

  constructor(message: string, rawOutput: string, sessionIds: string[] = []) {
    super(message);
    this.name = "ReviewOutputParseError";
    this.rawOutput = rawOutput;
    this.sessionIds = sessionIds;
  }
}

function extractLastJsonBlock(raw: string): { block: string | null; malformedFence: boolean } {
  // Brace-balance from each real ```json fence rather than regexing to the
  // next ```: a finding body may itself contain an encoded fenced snippet,
  // and a non-greedy match stops at that inner fence text.
  let last: string | null = null;
  let sawFence = false;
  let lastFenceMalformed = false;
  for (const m of raw.matchAll(JSON_FENCE_MARKER)) {
    sawFence = true;
    const contentStart = m.index + m[0].length;
    CLOSING_FENCE_MARKER.lastIndex = contentStart;
    const closingFence = CLOSING_FENCE_MARKER.exec(raw);
    const contentEnd = closingFence?.index ?? raw.length;
    const start = raw.indexOf("{", contentStart);
    if (start === -1 || start >= contentEnd) {
      last = null;
      lastFenceMalformed = true;
      continue;
    }
    const block = balancedBlock(raw.slice(0, contentEnd), start);
    last = block;
    lastFenceMalformed = block === null;
  }
  if (sawFence) return { block: last, malformedFence: lastFenceMalformed };
  // Fallback: scan for the first top-level `{...}` whose contents look like
  // our schema (mentions "summary" or "comments" or "resolved" near the
  // start). Walks forward, tracking string/escape state, until braces balance.
  for (let start = raw.indexOf("{"); start !== -1; start = raw.indexOf("{", start + 1)) {
    const block = balancedBlock(raw, start);
    if (!block) continue;
    if (/"(summary|comments|resolved|explanation)"\s*:/.test(block)) {
      return { block, malformedFence: false };
    }
  }
  return { block: null, malformedFence: false };
}

function balancedBlock(raw: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i]!;
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c === "\\") {
        esc = true;
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

export function parseReviewOutput(
  raw: string,
  sessionIds: string[] = [],
): { summary: string; comments: ReviewComment[] } {
  const extracted = extractLastJsonBlock(raw);
  if (extracted.malformedFence) {
    throw new ReviewOutputParseError(
      "AI reviewer returned a malformed fenced review JSON object.",
      raw,
      sessionIds,
    );
  }
  if (!extracted.block) {
    throw new ReviewOutputParseError(
      "AI reviewer returned no complete review JSON object.",
      raw,
      sessionIds,
    );
  }
  try {
    const parsed = JSON.parse(extracted.block);
    const result = ReviewSchema.parse(parsed);
    const comments: ReviewComment[] = result.comments.map((c) => ({
      path: c.path ?? null,
      line: c.line ?? null,
      side: c.side ?? (c.path ? "RIGHT" : null),
      severity: c.severity,
      body: c.body,
    }));
    const summary =
      result.summary.trim() ||
      `Review completed with ${comments.length} finding${comments.length === 1 ? "" : "s"}.`;
    return { summary, comments };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ReviewOutputParseError(
      `AI reviewer returned invalid review JSON: ${reason}`,
      raw,
      sessionIds,
    );
  }
}

export function parseRevalidateOutput(
  raw: string,
): { resolved: boolean; explanation: string } | null {
  const extracted = extractLastJsonBlock(raw);
  if (!extracted.block || extracted.malformedFence) return null;
  try {
    const parsed = JSON.parse(extracted.block);
    return RevalidateSchema.parse(parsed);
  } catch {
    return null;
  }
}
