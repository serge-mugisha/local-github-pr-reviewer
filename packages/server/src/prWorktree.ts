import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dataDir } from "./config.js";
import type { RepoRow, PrRow } from "./db.js";
import type { ProviderProgress } from "./providers/types.js";

export interface PrWorktree {
  cwd: string;
  cleanup(): Promise<void>;
}

function runGit(args: string[], cwd: string, onProgress?: ProviderProgress): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
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
      if (code !== 0) {
        rejectP(new Error(`git ${args.join(" ")} exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolveP(stdout.trim());
    });
    child.on("error", rejectP);
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
        await runGit(["worktree", "remove", "--force", worktreePath], repo.local_path, onProgress);
      } catch (e) {
        onProgress?.({ type: "stderr", data: `Cleanup failed: ${(e as Error).message}` });
      }
    },
  };
}
