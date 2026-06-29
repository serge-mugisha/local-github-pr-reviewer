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
    timeoutMs: 15 * 60 * 1000,
  });
  if (res.exitCode !== 0) {
    if (isAuthError(`${res.stderr}\n${res.stdout}`)) throw new Error(AUTH_HELP);
    throw new Error(`agy exited ${res.exitCode}: ${res.stderr.slice(0, 500)}`);
  }
  if (res.stdout.trim()) return { text: res.stdout, sessionIds: [] };
  if (isAuthError(res.stderr)) throw new Error(AUTH_HELP);
  throw new Error("agy produced no assistant output");
}

export const antigravityProvider: Provider = {
  id: "antigravity",
  displayName: "Antigravity (agy)",

  async isAvailable() {
    return commandExists("agy");
  },

  async review(ctx, onProgress) {
    const prompt = buildReviewPrompt(ctx);
    const { text, sessionIds } = await runAntigravity(prompt, ctx.cwd, onProgress);
    const { summary, comments } = parseReviewOutput(text);
    return { summary, comments, rawOutput: text, sessionIds } satisfies ReviewResult;
  },

  async reply(ctx, onProgress) {
    const prompt = buildReplyPrompt(ctx);
    const { text, sessionIds } = await runAntigravity(prompt, ctx.cwd, onProgress);
    return { body: text.trim(), rawOutput: text, sessionIds } satisfies ReplyResult;
  },

  async revalidate(ctx, onProgress) {
    const prompt = buildRevalidatePrompt(ctx);
    const { text, sessionIds } = await runAntigravity(prompt, ctx.cwd, onProgress);
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
