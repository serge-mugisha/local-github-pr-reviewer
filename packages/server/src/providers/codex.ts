import type {
  Provider,
  ReviewResult,
  ReplyResult,
  RevalidateResult,
  ProviderProgress,
} from "./types.js";
import { buildReviewPrompt, buildReplyPrompt, buildRevalidatePrompt } from "./prompt.js";
import { parseReviewOutput, parseRevalidateOutput } from "./parser.js";
import { spawnCli, commandExists, formatCliFailure } from "./spawn.js";
import { loadConfig } from "../config.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, rm } from "node:fs/promises";

/**
 * Runs `codex exec` inside the local working copy. Codex brings its own
 * Read/Grep/shell tools; a read-only sandbox is enough to investigate the
 * diff and is the conservative default for a reviewer (overridable in config).
 */

interface CodexRun {
  text: string;
  sessionIds: string[];
}

// `codex exec --json` emits one JSON event per line. We only need the session
// id (`thread.started`) and the final assistant turn (`agent_message`).
interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: { type?: string; text?: string };
}

function isAuthError(text: string): boolean {
  return /not logged in|unauthorized|401|run `?codex login|OPENAI_API_KEY/i.test(text);
}

const AUTH_HELP =
  "Codex authentication failed. Run `codex login` (or set OPENAI_API_KEY) so " +
  "the CLI can authenticate, then re-run the review.";

/** Pull the session id and final assistant message out of the JSONL stream. */
function parseCodexEvents(stdout: string): CodexRun {
  let text = "";
  const sessionIds: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: CodexEvent;
    try {
      ev = JSON.parse(trimmed) as CodexEvent;
    } catch {
      continue;
    }
    if (ev.type === "thread.started" && ev.thread_id) sessionIds.push(ev.thread_id);
    // Last agent_message wins — that's the final turn the model returns.
    if (ev.type === "item.completed" && ev.item?.type === "agent_message" && ev.item.text != null) {
      text = ev.item.text;
    }
  }
  return { text, sessionIds };
}

async function runCodex(
  prompt: string,
  cwd: string,
  onProgress?: ProviderProgress,
  signal?: AbortSignal,
): Promise<CodexRun> {
  onProgress?.({ type: "log", data: `[codex] running in ${cwd}\n` });
  const cfg = loadConfig().codex;
  // Reviewer does not use Codex's interactive model picker. Disable remote
  // catalog refreshes so concurrent/newer Codex installations cannot leave a
  // shared models_cache.json that this CLI version cannot deserialize.
  const args = [
    "exec",
    "--json",
    "-c",
    "features.remote_models=false",
    "--skip-git-repo-check",
    "-C",
    cwd,
  ];
  args.push("-s", cfg?.sandbox ?? "read-only");
  if (cfg?.model) args.push("-m", cfg.model);
  const res = await spawnCli({
    cmd: "codex",
    args,
    cwd,
    stdin: prompt,
    onProgress,
    signal,
    timeoutMs: 15 * 60 * 1000,
  });
  if (res.exitCode !== 0) {
    const failure = formatCliFailure("codex", res);
    throw new Error(isAuthError(res.combinedOutput) ? `${failure}\n\n${AUTH_HELP}` : failure);
  }
  const run = parseCodexEvents(res.stdout);
  if (!run.text.trim()) {
    const failure = formatCliFailure("codex", res, "produced no assistant output");
    throw new Error(isAuthError(res.combinedOutput) ? `${failure}\n\n${AUTH_HELP}` : failure);
  }
  return run;
}

/**
 * Codex persists each session as
 * `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<session-id>.jsonl`. The
 * session id (a UUID) is in the filename, so a recursive scan matches exactly.
 */
async function deleteCodexSessions(sessionIds: string[]): Promise<number> {
  const wanted = sessionIds.filter(Boolean);
  if (wanted.length === 0) return 0;
  const root = join(homedir(), ".codex", "sessions");
  let entries: string[];
  try {
    entries = await readdir(root, { recursive: true });
  } catch {
    return 0; // no sessions dir
  }
  let removed = 0;
  for (const id of wanted) {
    const match = entries.find((e) => e.endsWith(".jsonl") && e.includes(id));
    if (!match) continue;
    try {
      await rm(join(root, match), { force: true });
      removed++;
    } catch {
      /* best-effort */
    }
  }
  return removed;
}

export const codexProvider: Provider = {
  id: "codex",
  displayName: "Codex (CLI)",

  async isAvailable() {
    return commandExists("codex");
  },

  async review(ctx, onProgress, signal) {
    const prompt = buildReviewPrompt(ctx);
    const { text, sessionIds } = await runCodex(prompt, ctx.cwd, onProgress, signal);
    const { summary, comments } = parseReviewOutput(text, sessionIds);
    return { summary, comments, rawOutput: text, sessionIds } satisfies ReviewResult;
  },

  async reply(ctx, onProgress, signal) {
    const prompt = buildReplyPrompt(ctx);
    const { text, sessionIds } = await runCodex(prompt, ctx.cwd, onProgress, signal);
    return { body: text.trim(), rawOutput: text, sessionIds } satisfies ReplyResult;
  },

  async revalidate(ctx, onProgress, signal) {
    const prompt = buildRevalidatePrompt(ctx);
    const { text, sessionIds } = await runCodex(prompt, ctx.cwd, onProgress, signal);
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
    return deleteCodexSessions(sessionIds);
  },
};
