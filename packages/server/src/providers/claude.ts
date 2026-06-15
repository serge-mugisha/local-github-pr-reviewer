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
import { readdir, rm } from "node:fs/promises";

/**
 * Runs `claude -p` inside the local working copy. The model brings its own
 * Read/Grep/Bash tools — we just hand it a prompt and a cwd.
 */

interface ClaudeJsonResult {
  result?: string;
  is_error?: boolean;
  error?: string;
  session_id?: string;
}

interface ClaudeRun {
  text: string;
  sessionIds: string[];
}

async function runClaude(
  prompt: string,
  cwd: string,
  onProgress?: ProviderProgress,
): Promise<ClaudeRun> {
  onProgress?.({ type: "log", data: `[claude] running in ${cwd}\n` });
  const args = ["-p", "--output-format", "json", "--permission-mode", "bypassPermissions"];
  const res = await spawnCli({
    cmd: "claude",
    args,
    cwd,
    stdin: prompt,
    onProgress,
    timeoutMs: 15 * 60 * 1000,
  });
  if (res.exitCode !== 0) {
    throw new Error(`claude exited ${res.exitCode}: ${res.stderr.slice(0, 500)}`);
  }
  // With --output-format json, stdout is a JSON object containing `result`.
  // Parse first; check is_error *after* the catch so a reported error isn't
  // swallowed and mistaken for successful output.
  let parsed: ClaudeJsonResult | null = null;
  try {
    parsed = JSON.parse(res.stdout) as ClaudeJsonResult;
  } catch {
    parsed = null;
  }
  if (parsed) {
    if (parsed.is_error) throw new Error(parsed.error || "claude reported an error");
    return {
      text: parsed.result ?? "",
      sessionIds: parsed.session_id ? [parsed.session_id] : [],
    };
  }
  // Not JSON for some reason — fall back to raw stdout (no id to track).
  if (res.stdout.trim()) return { text: res.stdout, sessionIds: [] };
  throw new Error("claude output not parseable");
}

/**
 * Claude Code persists each session as
 * `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, where the directory
 * is the cwd with non-alphanumeric chars replaced by `-`. We check that
 * project dir first, then fall back to other dirs in case the encoding
 * differs (session ids are UUIDs, so the filename match stays unambiguous).
 */
async function deleteClaudeSessions(sessionIds: string[], cwd: string): Promise<number> {
  const wanted = new Set(sessionIds.filter(Boolean).map((id) => `${id}.jsonl`));
  if (wanted.size === 0) return 0;
  const projectsDir = join(homedir(), ".claude", "projects");
  let dirs: string[];
  try {
    dirs = (await readdir(projectsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return 0; // no projects dir → nothing to clean
  }
  const preferred = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  dirs.sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : 0));
  let removed = 0;
  for (const dir of dirs) {
    if (wanted.size === 0) break; // found them all
    let files: string[];
    try {
      files = await readdir(join(projectsDir, dir));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!wanted.has(file)) continue;
      try {
        await rm(join(projectsDir, dir, file), { force: true });
        removed++;
        wanted.delete(file);
      } catch {
        /* best-effort */
      }
    }
  }
  return removed;
}

export const claudeProvider: Provider = {
  id: "claude",
  displayName: "Claude (CLI)",

  async isAvailable() {
    return commandExists("claude");
  },

  async review(ctx, onProgress) {
    const prompt = buildReviewPrompt(ctx);
    const { text, sessionIds } = await runClaude(prompt, ctx.cwd, onProgress);
    const { summary, comments } = parseReviewOutput(text);
    return { summary, comments, rawOutput: text, sessionIds } satisfies ReviewResult;
  },

  async reply(ctx, onProgress) {
    const prompt = buildReplyPrompt(ctx);
    const { text, sessionIds } = await runClaude(prompt, ctx.cwd, onProgress);
    return { body: text.trim(), rawOutput: text, sessionIds } satisfies ReplyResult;
  },

  async revalidate(ctx, onProgress) {
    const prompt = buildRevalidatePrompt(ctx);
    const { text, sessionIds } = await runClaude(prompt, ctx.cwd, onProgress);
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
    return deleteClaudeSessions(sessionIds, cwd);
  },
};
