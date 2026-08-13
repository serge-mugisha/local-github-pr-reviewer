import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { readdir, rm, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dataDir } from "./config.js";
import type { RepoRow, PrRow } from "./db.js";
import type { ProviderProgress } from "./providers/types.js";

export interface PrWorktree {
  cwd: string;
  cleanup(): Promise<void>;
}

const WORKTREE_CLEANUP_TIMEOUT_MS = 30_000;
const STALE_WORKTREE_AFTER_MS = 30 * 60 * 1_000;

function runGit(
  args: string[],
  cwd: string,
  onProgress?: ProviderProgress,
  timeoutMs?: number,
): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;

    if (timeoutMs) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
        rejectP(new Error(`git ${args.join(" ")} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }
    child.stdout.on("data", (b) => {
      const s = b.toString();
      stdout += s;
      onProgress?.({ type: "stdout", data: s });
    });
    child.stderr.on("data", (b) => {
      const s = b.toString();
      stderr += s;
      onProgress?.({ type: "stderr", data: s });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        rejectP(new Error(`git ${args.join(" ")} exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolveP(stdout.trim());
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (settled) return;
      settled = true;
      rejectP(error);
    });
  });
}

export async function pruneWorktrees(repos: RepoRow[]): Promise<void> {
  // Prune git metadata in all repos
  await Promise.all(
    repos.map(async (repo) => {
      try {
        await runGit(["worktree", "prune"], repo.local_path);
      } catch {
        // ignore
      }
    }),
  );

  // Sweep the worktrees directory
  try {
    await rm(resolve(dataDir(), "worktrees"), { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/**
 * Recover abandoned Reviewer worktrees without touching a checkout that may
 * belong to another active MCP process. Provider runs are capped at 15 minutes,
 * so a 30-minute-old worktree can no longer be part of a live review.
 */
export async function pruneStaleWorktrees(
  repos: RepoRow[],
  staleAfterMs = STALE_WORKTREE_AFTER_MS,
): Promise<number> {
  const cutoff = Date.now() - staleAfterMs;
  let removed = 0;

  for (const repo of repos) {
    const repoWorktrees = resolve(dataDir(), `worktrees/repo-${repo.id}`);
    let entries;
    try {
      entries = await readdir(repoWorktrees, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const worktreePath = resolve(repoWorktrees, entry.name);
      try {
        const info = await stat(worktreePath);
        if (info.mtimeMs >= cutoff) continue;
        try {
          await runGit(
            ["worktree", "remove", "--force", worktreePath],
            repo.local_path,
            undefined,
            WORKTREE_CLEANUP_TIMEOUT_MS,
          );
        } catch {
          // The checkout may have outlived its git metadata. It is still safe
          // to remove because it is Reviewer-owned and older than the cap.
          await rm(worktreePath, { recursive: true, force: true });
        }
        removed++;
      } catch (error) {
        console.error(`Reviewer stale worktree cleanup failed: ${String(error)}`);
      }
    }

    try {
      await runGit(["worktree", "prune"], repo.local_path, undefined, WORKTREE_CLEANUP_TIMEOUT_MS);
    } catch (error) {
      console.error(`Reviewer worktree metadata pruning failed: ${String(error)}`);
    }
  }

  return removed;
}

export async function preparePrHeadWorktree(args: {
  repo: RepoRow;
  pr: Pick<PrRow, "number" | "head_sha">;
  onProgress?: ProviderProgress;
}): Promise<PrWorktree> {
  const { repo, pr, onProgress } = args;

  onProgress?.({
    type: "log",
    data: `Preparing worktree for PR #${pr.number} at ${pr.head_sha}...`,
  });

  const token = randomBytes(4).toString("hex");
  const worktreePath = resolve(
    dataDir(),
    `worktrees/repo-${repo.id}/pr-${pr.number}-${pr.head_sha}-${token}`,
  );

  // Fetch the PR head to a reviewer-owned ref
  const ref = `refs/reviewer/pr/${repo.id}/${pr.number}`;
  await runGit(
    ["fetch", "--no-tags", "origin", `+refs/pull/${pr.number}/head:${ref}`],
    repo.local_path,
    onProgress,
  );

  // Verify the fetched ref matches the expected head_sha
  const fetchedSha = await runGit(["rev-parse", ref], repo.local_path, onProgress);
  if (fetchedSha !== pr.head_sha) {
    throw new Error(`Fetched SHA (${fetchedSha}) does not match PR head_sha (${pr.head_sha})`);
  }

  // Create the detached worktree
  await runGit(
    ["worktree", "add", "--detach", worktreePath, pr.head_sha],
    repo.local_path,
    onProgress,
  );

  return {
    cwd: worktreePath,
    cleanup: async () => {
      try {
        await runGit(
          ["worktree", "remove", "--force", worktreePath],
          repo.local_path,
          undefined,
          WORKTREE_CLEANUP_TIMEOUT_MS,
        );
      } catch (e) {
        // Cleanup runs after the review completion signal, so its original SSE
        // progress stream may already be closed. Report it to the process log.
        console.error(`Reviewer worktree cleanup failed: ${(e as Error).message}`);
      }
    },
  };
}
