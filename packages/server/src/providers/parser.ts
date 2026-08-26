import { z } from "zod";
import type { ReviewComment } from "./types.js";

const CommentSchema = z.object({
  path: z.string().nullable().optional(),
  line: z.number().int().nullable().optional(),
  side: z.enum(["LEFT", "RIGHT"]).nullable().optional(),
  severity: z.enum(["blocker", "concern", "nit", "praise"]).default("concern"),
  body: z.string().min(1),
});

const ReviewSchema = z.object({
  summary: z.string().min(1),
  comments: z.array(CommentSchema),
});

const RevalidateSchema = z.object({
  resolved: z.boolean(),
  explanation: z.string().default(""),
});

// Match only actual Markdown fence lines. A review comment body can contain
// the encoded characters ```json, but inside the outer JSON string they are
// not on a physical line of provider output and must not become candidates.
const JSON_FENCE_MARKER = /^[\t ]*```json[\t ]*\r?$/gim;

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

function extractLastJsonBlock(raw: string): string | null {
  // Brace-balance from each real ```json fence rather than regexing to the
  // next ```: a finding body may itself contain an encoded fenced snippet,
  // and a non-greedy match stops at that inner fence text.
  let last: string | null = null;
  for (const m of raw.matchAll(JSON_FENCE_MARKER)) {
    const start = raw.indexOf("{", m.index + m[0].length);
    if (start === -1) continue;
    const block = balancedBlock(raw, start);
    if (block) last = block;
  }
  if (last) return last;
  // Fallback: scan for the first top-level `{...}` whose contents look like
  // our schema (mentions "summary" or "comments" or "resolved" near the
  // start). Walks forward, tracking string/escape state, until braces balance.
  for (let start = raw.indexOf("{"); start !== -1; start = raw.indexOf("{", start + 1)) {
    const block = balancedBlock(raw, start);
    if (!block) continue;
    if (/"(summary|comments|resolved|explanation)"\s*:/.test(block)) return block;
  }
  return null;
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
  const block = extractLastJsonBlock(raw);
  if (!block) {
    throw new ReviewOutputParseError(
      "AI reviewer returned no complete review JSON object.",
      raw,
      sessionIds,
    );
  }
  try {
    const parsed = JSON.parse(block);
    const result = ReviewSchema.parse(parsed);
    const comments: ReviewComment[] = result.comments.map((c) => ({
      path: c.path ?? null,
      line: c.line ?? null,
      side: c.side ?? (c.path ? "RIGHT" : null),
      severity: c.severity,
      body: c.body,
    }));
    return { summary: result.summary, comments };
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
  const block = extractLastJsonBlock(raw);
  if (!block) return null;
  try {
    const parsed = JSON.parse(block);
    return RevalidateSchema.parse(parsed);
  } catch {
    return null;
  }
}
