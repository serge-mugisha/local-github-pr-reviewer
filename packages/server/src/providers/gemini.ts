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
import { readdir, readFile, writeFile, rm } from "node:fs/promises";

/**
 * Runs `gemini -p` inside the local working copy, with yolo approval so the
 * model can read/grep/run tests without prompting.
 */

interface GeminiRun {
  text: string;
  sessionIds: string[];
}

// `--output-format json` wraps the model output as
// `{ session_id, response, stats, error }`, so we get our exact session id
// straight from stdout — no guessing which conversation in the shared
// per-project log is ours.
interface GeminiJsonResult {
  session_id?: string;
  response?: string;
  error?: { message?: string } | string;
}

const geminiTmpDir = (): string => join(homedir(), ".gemini", "tmp");

/** The project tmp dir for `cwd`, resolved via Gemini's own cwd→label map. */
async function geminiProjectDirForCwd(cwd: string): Promise<string | null> {
  try {
    const raw = await readFile(join(homedir(), ".gemini", "projects.json"), "utf8");
    const { projects } = JSON.parse(raw) as { projects?: Record<string, string> };
    const label = projects?.[cwd];
    if (label) return join(geminiTmpDir(), label);
  } catch {
    /* missing/malformed map → fall back to scanning */
  }
  return null;
}

/** Every `~/.gemini/tmp/<project>` dir (fallback when cwd doesn't resolve). */
async function allGeminiProjectDirs(): Promise<string[]> {
  const tmp = geminiTmpDir();
  try {
    return (await readdir(tmp, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => join(tmp, d.name));
  } catch {
    return [];
  }
}

async function runGemini(
  prompt: string,
  cwd: string,
  onProgress?: ProviderProgress,
): Promise<GeminiRun> {
  onProgress?.({ type: "log", data: `[gemini] running in ${cwd}\n` });
  const args = ["--approval-mode", "yolo", "--output-format", "json", "-p", prompt];
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
  let parsed: GeminiJsonResult | null = null;
  try {
    parsed = JSON.parse(res.stdout) as GeminiJsonResult;
  } catch {
    parsed = null;
  }
  if (parsed) {
    if (parsed.error) {
      const msg = typeof parsed.error === "string" ? parsed.error : parsed.error.message;
      throw new Error(msg || "gemini reported an error");
    }
    return {
      text: parsed.response ?? "",
      sessionIds: parsed.session_id ? [parsed.session_id] : [],
    };
  }
  // Not JSON for some reason — fall back to raw stdout (no id to track).
  if (res.stdout.trim()) return { text: res.stdout, sessionIds: [] };
  throw new Error("gemini output not parseable");
}

/**
 * Delete the given sessions from a project's on-disk history. Current Gemini
 * writes one file per session at `<project>/chats/session-*.json`; older
 * versions appended to a shared `<project>/logs.json`. We clean both. Session
 * ids are UUIDs, so every match is exact.
 */
async function deleteGeminiSessions(sessionIds: string[], cwd: string): Promise<number> {
  const wanted = new Set(sessionIds.filter(Boolean));
  if (wanted.size === 0) return 0;
  // Scope to cwd's project (where the session was created) so we never touch
  // another project's history; fall back to scanning if cwd doesn't resolve.
  const scoped = await geminiProjectDirForCwd(cwd);
  const dirs = scoped ? [scoped] : await allGeminiProjectDirs();
  const removed = new Set<string>();
  for (const dir of dirs) {
    await deleteFromChats(join(dir, "chats"), wanted, removed);
    await deleteFromLogsJson(join(dir, "logs.json"), wanted, removed);
  }
  return removed.size;
}

/** Per-session files: delete each `chats/session-*.json` whose sessionId matches. */
async function deleteFromChats(
  chatsDir: string,
  wanted: Set<string>,
  removed: Set<string>,
): Promise<void> {
  let files: string[];
  try {
    files = await readdir(chatsDir);
  } catch {
    return; // no chats dir
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const path = join(chatsDir, file);
    let sessionId: string | undefined;
    try {
      sessionId = (JSON.parse(await readFile(path, "utf8")) as { sessionId?: string }).sessionId;
    } catch {
      continue;
    }
    if (!sessionId || !wanted.has(sessionId)) continue;
    try {
      await rm(path, { force: true });
      removed.add(sessionId);
    } catch {
      /* best-effort */
    }
  }
}

/** Legacy shared log: strip matching entries from `logs.json`, rewriting if changed. */
async function deleteFromLogsJson(
  logPath: string,
  wanted: Set<string>,
  removed: Set<string>,
): Promise<void> {
  let entries: { sessionId?: string }[];
  try {
    entries = JSON.parse(await readFile(logPath, "utf8")) as { sessionId?: string }[];
  } catch {
    return; // no/invalid logs.json
  }
  if (!Array.isArray(entries)) return;
  const kept = entries.filter((e) => !(e?.sessionId && wanted.has(e.sessionId)));
  if (kept.length === entries.length) return;
  for (const e of entries) if (e?.sessionId && wanted.has(e.sessionId)) removed.add(e.sessionId);
  try {
    await writeFile(logPath, JSON.stringify(kept, null, 2));
  } catch {
    /* best-effort */
  }
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

  async deleteSessions(sessionIds, cwd) {
    return deleteGeminiSessions(sessionIds, cwd);
  },
};
