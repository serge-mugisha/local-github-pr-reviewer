import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnCli } from "./providers/spawn.js";

async function execGit(args: string[], cwd: string): Promise<string> {
  const result = await spawnCli({
    cmd: "git",
    args,
    cwd,
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/**
 * Creates an isolated git worktree for a specific PR commit, executes the callback,
 * and then automatically cleans up the worktree.
 */
export async function withWorktree<T>(
  repoPath: string,
  prNumber: number,
  headSha: string,
  callback: (worktreePath: string) => Promise<T>
): Promise<T> {
  // First, ensure we have the commit locally.
  // We fetch the PR head explicitly from the default 'origin' remote.
  try {
    await execGit(["fetch", "origin", `pull/${prNumber}/head`], repoPath);
  } catch (e) {
    // If 'origin' fails, try to fetch the SHA directly in case it exists locally
    // or if the remote configuration is non-standard.
    console.warn(`Failed to fetch PR ${prNumber} from origin, ensuring SHA exists...`, e);
    // This will throw if the commit isn't available at all.
    await execGit(["cat-file", "-e", headSha], repoPath);
  }

  const worktreeId = crypto.randomUUID();
  const worktreePath = path.join(os.tmpdir(), `reviewer-worktree-${worktreeId}`);

  try {
    // Create a detached worktree at the specific commit
    await execGit(["worktree", "add", "-d", worktreePath, headSha], repoPath);

    return await callback(worktreePath);
  } finally {
    // Cleanup the worktree
    try {
      await execGit(["worktree", "remove", "--force", worktreePath], repoPath);
    } catch (e) {
      console.error(`Failed to cleanup worktree ${worktreePath}:`, e);
    }
  }
}
