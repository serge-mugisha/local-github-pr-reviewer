import { resolve } from "node:path";
import { readdir, rm, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dataDir } from "./config.js";
import type { RepoRow, PrRow } from "./db.js";
import type { ProviderProgress } from "./providers/types.js";
import { spawnCli } from "./providers/spawn.js";

export interface PrWorktree {
  cwd: string;
  cleanup(): Promise<void>;
}

const WORKTREE_CLEANUP_TIMEOUT_MS = 30_000;
const STALE_WORKTREE_AFTER_MS = 30 * 60 * 1_000;

async function runGit(
  args: string[],
  cwd: string,
  onProgress?: ProviderProgress,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<string> {
  const result = await spawnCli({
    cmd: "git",
    args,
    cwd,
    onProgress,
    timeoutMs,
    signal,
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${result.exitCode}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
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
    let entries: Array<{ isDirectory(): boolean; name: string }>;
    try {
      entries = await readdir(repoWorktrees, { withFileTypes: true });
    } catch {
      entries = [];
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

    try {
      const refs = await runGit(
        ["for-each-ref", "--format=%(refname)", "refs/reviewer/actions"],
        repo.local_path,
        undefined,
        WORKTREE_CLEANUP_TIMEOUT_MS,
      );
      for (const ref of refs.split("\n").filter(Boolean)) {
        const match = /^refs\/reviewer\/actions\/\d+-\d+-(\d+)-[0-9a-f]{8}$/.exec(ref);
        if (!match || Number(match[1]) >= cutoff) continue;
        await runGit(["update-ref", "-d", ref], repo.local_path, undefined, 5_000);
      }
    } catch (error) {
      console.error(`Reviewer action-ref cleanup failed: ${String(error)}`);
    }
  }

  return removed;
}

export async function preparePrHeadWorktree(args: {
  repo: RepoRow;
  pr: Pick<PrRow, "number" | "head_sha">;
  onProgress?: ProviderProgress;
  signal?: AbortSignal;
}): Promise<PrWorktree> {
  const { repo, pr, onProgress, signal } = args;

  onProgress?.({
    type: "log",
    data: `Preparing worktree for PR #${pr.number} at ${pr.head_sha}...`,
  });

  const token = randomBytes(4).toString("hex");
  const createdAt = Date.now();
  const worktreePath = resolve(
    dataDir(),
    `worktrees/repo-${repo.id}/pr-${pr.number}-${pr.head_sha}-${token}`,
  );

  // Every action gets its own ref. Concurrent reviews or revalidations of the
  // same PR must never race while force-updating one shared ref.
  // Keep this namespace disjoint from the historical
  // refs/reviewer/pr/<repo>/<number> leaf refs already present in upgrades.
  const ref = `refs/reviewer/actions/${repo.id}-${pr.number}-${createdAt}-${token}`;
  try {
    await runGit(
      ["fetch", "--no-tags", "origin", `+refs/pull/${pr.number}/head:${ref}`],
      repo.local_path,
      onProgress,
      undefined,
      signal,
    );

    const fetchedSha = await runGit(
      ["rev-parse", ref],
      repo.local_path,
      onProgress,
      undefined,
      signal,
    );
    if (fetchedSha !== pr.head_sha) {
      throw new Error(`Fetched SHA (${fetchedSha}) does not match PR head_sha (${pr.head_sha})`);
    }

    await runGit(
      ["worktree", "add", "--detach", worktreePath, pr.head_sha],
      repo.local_path,
      onProgress,
      undefined,
      signal,
    );
  } catch (error) {
    try {
      await runGit(["update-ref", "-d", ref], repo.local_path, undefined, 5_000);
    } catch {
      // The timestamped stale-ref sweep handles interrupted preparation.
    }
    throw error;
  }

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
      try {
        await runGit(["update-ref", "-d", ref], repo.local_path, undefined, 5_000);
      } catch (e) {
        console.error(`Reviewer action-ref cleanup failed: ${(e as Error).message}`);
      }
    },
  };
}
