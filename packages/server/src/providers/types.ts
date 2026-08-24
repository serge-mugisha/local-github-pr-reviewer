export interface ReviewComment {
  path: string | null;
  line: number | null;
  side: "LEFT" | "RIGHT" | null;
  severity: "blocker" | "concern" | "nit" | "praise";
  body: string;
}

export interface ReviewResult {
  summary: string;
  comments: ReviewComment[];
  rawOutput: string;
  /** Chat session id(s) the CLI persisted for this run, if any. Tracked so
   *  they can be deleted when the PR is purged. */
  sessionIds?: string[];
}

export interface ReviewInstructionConfig {
  categories: string[]; // enabled category keys (see reviewCatalog)
  strictness: string; // strictness key (see reviewCatalog)
  globalRules: string; // custom rules applied to every PR
  repoRules: string; // per-repo rules (the Skills page)
  perPrRules: string; // custom rules for this PR only
  pathInclude: string; // optional focus globs
  pathExclude: string; // optional ignore globs
}

export interface ReviewContext {
  cwd: string; // local working copy of the repo
  prTitle: string;
  prBody: string;
  prNumber: number;
  repoSlug: string; // owner/name
  headSha: string;
  baseSha: string;
  diff: string; // unified diff (may be chunked by caller)
  skills: string; // per-repo notes/rules markdown
  config: ReviewInstructionConfig; // resolved review configuration
  existingOpenThreads: { path: string | null; line: number | null; summary: string }[];
}

export interface ReplyContext {
  cwd: string;
  prTitle: string;
  prNumber: number;
  repoSlug: string;
  headSha: string;
  threadAnchor: { path: string | null; line: number | null };
  threadHistory: { author: "ai" | "user"; body: string }[];
  userMessage: string;
  skills: string;
}

export interface RevalidateContext {
  cwd: string;
  prTitle: string;
  prNumber: number;
  repoSlug: string;
  headSha: string;
  baseSha: string;
  threadAnchor: { path: string | null; line: number | null };
  threadHistory: { author: "ai" | "user"; body: string }[];
  skills: string;
}

export interface RevalidateResult {
  resolved: boolean;
  body: string; // explanation: why resolved, or what's still missing
  rawOutput: string;
  sessionIds?: string[];
}

export interface ReplyResult {
  body: string;
  rawOutput: string;
  sessionIds?: string[];
}

export interface ProviderProgress {
  (event: { type: "log" | "stdout" | "stderr"; data: string }): void;
}

export interface Provider {
  id: "claude" | "antigravity" | "codex" | string;
  displayName: string;
  isAvailable(): Promise<boolean>;
  review(
    ctx: ReviewContext,
    onProgress?: ProviderProgress,
    signal?: AbortSignal,
  ): Promise<ReviewResult>;
  reply(
    ctx: ReplyContext,
    onProgress?: ProviderProgress,
    signal?: AbortSignal,
  ): Promise<ReplyResult>;
  revalidate(
    ctx: RevalidateContext,
    onProgress?: ProviderProgress,
    signal?: AbortSignal,
  ): Promise<RevalidateResult>;
  /** Delete the on-disk chat sessions this provider persisted for the given
   *  session ids (run in `cwd`). Returns how many sessions were removed. */
  deleteSessions?(sessionIds: string[], cwd: string): Promise<number>;
}
