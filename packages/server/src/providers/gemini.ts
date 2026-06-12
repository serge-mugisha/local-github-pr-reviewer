import type {
  Provider,
  ReviewResult,
  ReplyResult,
  RevalidateResult,
  ProviderProgress,
} from "./types.js";
import { buildReviewPrompt, buildReplyPrompt, buildRevalidatePrompt } from "./prompt.js";
import { parseReviewOutput, parseRevalidateOutput } from "./parser.js";
import { spawnCli, commandExists } from "./spawn.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, readFile, writeFile } from "node:fs/promises";

/**
 * Runs `gemini -p` inside the local working copy, with yolo approval so the
 * model can read/grep/run tests without prompting.
 */

interface GeminiRun {
  text: string;
  sessionIds: string[];
}

// Gemini persists conversation turns in `~/.gemini/tmp/<project>/logs.json`,
// one shared append-log per project keyed by `sessionId`. We can't know our
// session id up front, so we snapshot the ids present before/after the run
// and attribute the new ones to this invocation.
const geminiTmpDir = (): string => join(homedir(), ".gemini", "tmp");

async function geminiLogFiles(): Promise<string[]> {
  const tmp = geminiTmpDir();
  let entries: string[];
  try {
    entries = (await readdir(tmp, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => join(tmp, d.name, "logs.json"));
  } catch {
    return [];
  }
  return entries;
}

async function readSessionIds(logPath: string): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    const raw = await readFile(logPath, "utf8");
    const entries = JSON.parse(raw) as { sessionId?: string }[];
    for (const e of entries) if (e?.sessionId) ids.add(e.sessionId);
  } catch {
    /* missing or malformed — treat as empty */
  }
  return ids;
}

async function snapshotGeminiSessionIds(): Promise<Set<string>> {
  const all = new Set<string>();
  for (const file of await geminiLogFiles()) {
    for (const id of await readSessionIds(file)) all.add(id);
  }
  return all;
}

async function runGemini(
  prompt: string,
  cwd: string,
  onProgress?: ProviderProgress,
): Promise<GeminiRun> {
  onProgress?.({ type: "log", data: `[gemini] running in ${cwd}\n` });
  const before = await snapshotGeminiSessionIds();
  const args = ["--approval-mode", "yolo", "-p", prompt];
  const res = await spawnCli({
    cmd: "gemini",
    args,
    cwd,
    onProgress,
    timeoutMs: 15 * 60 * 1000,
  });
  if (res.exitCode !== 0) {
    throw new Error(`gemini exited ${res.exitCode}: ${res.stderr.slice(0, 500)}`);
  }
  const after = await snapshotGeminiSessionIds();
  const sessionIds = [...after].filter((id) => !before.has(id));
  return { text: res.stdout, sessionIds };
}

/**
 * Strip the given sessions out of every `logs.json`. Session ids are UUIDs,
 * so we can safely scan all project logs without resolving the cwd→project
 * mapping. Rewrites a file only when something was actually removed.
 */
async function deleteGeminiSessions(sessionIds: string[]): Promise<number> {
  const wanted = new Set(sessionIds.filter(Boolean));
  if (wanted.size === 0) return 0;
  let removedSessions = 0;
  for (const file of await geminiLogFiles()) {
    let entries: { sessionId?: string }[];
    try {
      entries = JSON.parse(await readFile(file, "utf8")) as { sessionId?: string }[];
    } catch {
      continue;
    }
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((e) => !(e?.sessionId && wanted.has(e.sessionId)));
    if (kept.length === entries.length) continue;
    const present = new Set(
      entries.flatMap((e) => (e?.sessionId && wanted.has(e.sessionId) ? [e.sessionId] : [])),
    );
    removedSessions += present.size;
    try {
      await writeFile(file, JSON.stringify(kept, null, 2));
    } catch {
      /* best-effort */
    }
  }
  return removedSessions;
}

export const geminiProvider: Provider = {
  id: "gemini",
  displayName: "Gemini (CLI)",

  async isAvailable() {
    return commandExists("gemini");
  },

  async review(ctx, onProgress) {
    const prompt = buildReviewPrompt(ctx);
    const { text, sessionIds } = await runGemini(prompt, ctx.cwd, onProgress);
    const { summary, comments } = parseReviewOutput(text);
    return { summary, comments, rawOutput: text, sessionIds } satisfies ReviewResult;
  },

  async reply(ctx, onProgress) {
    const prompt = buildReplyPrompt(ctx);
    const { text, sessionIds } = await runGemini(prompt, ctx.cwd, onProgress);
    return { body: text.trim(), rawOutput: text, sessionIds } satisfies ReplyResult;
  },

  async revalidate(ctx, onProgress) {
    const prompt = buildRevalidatePrompt(ctx);
    const { text, sessionIds } = await runGemini(prompt, ctx.cwd, onProgress);
    const parsed = parseRevalidateOutput(text);
    if (!parsed) {
      return {
        resolved: false,
        body: text.trim() || "Could not parse revalidation result.",
        rawOutput: text,
        sessionIds,
      };
    }
    return {
      resolved: parsed.resolved,
      body: parsed.explanation,
      rawOutput: text,
      sessionIds,
    } satisfies RevalidateResult;
  },

  async deleteSessions(sessionIds) {
    return deleteGeminiSessions(sessionIds);
  },
};
