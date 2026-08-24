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

/**
 * Runs `agy --print` inside the local working copy. Antigravity replaced the
 * old Gemini CLI and uses its own authenticated local app state.
 */

interface AntigravityRun {
  text: string;
  sessionIds: string[];
}

function isAuthError(text: string): boolean {
  return /not logged into Antigravity|authenticat|OAuth|token source|login/i.test(text);
}

const AUTH_HELP =
  "Antigravity authentication failed. Open Antigravity or run `agy` locally, " +
  "complete login, then re-run the review.";

async function runAntigravity(
  prompt: string,
  cwd: string,
  onProgress?: ProviderProgress,
  signal?: AbortSignal,
): Promise<AntigravityRun> {
  onProgress?.({ type: "log", data: `[antigravity] running in ${cwd}\n` });
  const cfg = loadConfig().antigravity;
  const args = ["--dangerously-skip-permissions", "--print-timeout", cfg?.printTimeout ?? "15m"];
  if (cfg?.sandbox ?? false) args.push("--sandbox");
  if (cfg?.model) args.push("--model", cfg.model);
  args.push("--print", prompt);
  const res = await spawnCli({
    cmd: "agy",
    args,
    cwd,
    onProgress,
    signal,
    timeoutMs: 15 * 60 * 1000,
  });
  if (res.exitCode !== 0) {
    const failure = formatCliFailure("agy", res);
    throw new Error(isAuthError(res.combinedOutput) ? `${failure}\n\n${AUTH_HELP}` : failure);
  }
  if (res.stdout.trim()) return { text: res.stdout, sessionIds: [] };
  const failure = formatCliFailure("agy", res, "produced no assistant output");
  throw new Error(isAuthError(res.combinedOutput) ? `${failure}\n\n${AUTH_HELP}` : failure);
}

export const antigravityProvider: Provider = {
  id: "antigravity",
  displayName: "Antigravity (agy)",

  async isAvailable() {
    return commandExists("agy");
  },

  async review(ctx, onProgress, signal) {
    const prompt = buildReviewPrompt(ctx);
    const { text, sessionIds } = await runAntigravity(prompt, ctx.cwd, onProgress, signal);
    const { summary, comments } = parseReviewOutput(text);
    return { summary, comments, rawOutput: text, sessionIds } satisfies ReviewResult;
  },

  async reply(ctx, onProgress, signal) {
    const prompt = buildReplyPrompt(ctx);
    const { text, sessionIds } = await runAntigravity(prompt, ctx.cwd, onProgress, signal);
    return { body: text.trim(), rawOutput: text, sessionIds } satisfies ReplyResult;
  },

  async revalidate(ctx, onProgress, signal) {
    const prompt = buildRevalidatePrompt(ctx);
    const { text, sessionIds } = await runAntigravity(prompt, ctx.cwd, onProgress, signal);
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

  async deleteSessions() {
    // `agy --print` does not expose a per-run conversation id. Avoid deleting
    // Antigravity's workspace database because it can contain unrelated user
    // history for the same checkout.
    return 0;
  },
};
