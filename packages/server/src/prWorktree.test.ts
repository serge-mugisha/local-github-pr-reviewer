import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { preparePrHeadWorktree, pruneStaleWorktrees, pruneWorktrees } from "./prWorktree.js";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readdir, rm, stat } from "node:fs/promises";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readdir: vi.fn().mockRejectedValue(new Error("enoent")),
  stat: vi.fn().mockRejectedValue(new Error("enoent")),
  rm: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./config.js", () => ({
  dataDir: () => "/data",
}));

describe("preparePrHeadWorktree", () => {
  let mockSpawn: any;

  beforeEach(() => {
    mockSpawn = spawn as any;
    mockSpawn.mockReset();
    vi.mocked(readdir).mockReset().mockRejectedValue(new Error("enoent"));
    vi.mocked(stat).mockReset().mockRejectedValue(new Error("enoent"));
    vi.mocked(rm).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setupGitMock(responses: Record<string, string>) {
    let invocation = 0;
    mockSpawn.mockImplementation((cmd: string, args: string[]) => {
      invocation++;
      const ee: any = new EventEmitter();
      ee.stdout = new EventEmitter();
      ee.stderr = new EventEmitter();
      ee.stdin = { end: vi.fn(), write: vi.fn() };
      ee.kill = vi.fn();
      ee.pid = 999_999_000 + invocation;

      let out = "";

      if (args[0] === "fetch") out = "";
      else if (args[0] === "rev-parse" && args[1] !== "HEAD") {
        out = responses["rev-parse ref"] || "correct_sha";
      } else if (args[0] === "rev-parse" && args[1] === "HEAD") {
        out = responses["rev-parse HEAD"] || "correct_sha";
      } else if (args[0] === "worktree") {
        out = "";
      }

      setTimeout(() => {
        ee.stdout.emit("data", Buffer.from(out));
        ee.emit("close", 0);
      }, 1);

      return ee;
    });
  }

  it("fetches ref and creates worktree", async () => {
    setupGitMock({
      "rev-parse ref": "test_sha",
    });

    const repo = { id: 1, owner: "o", name: "n", local_path: "/local" } as any;
    const pr = { number: 42, head_sha: "test_sha" };

    const wt = await preparePrHeadWorktree({ repo, pr });
    expect(wt.cwd).toMatch(/\/data\/worktrees\/repo-1\/pr-42-test_sha-[0-9a-f]{8}/);

    expect(mockSpawn).toHaveBeenCalledWith(
      "git",
      ["fetch", "--no-tags", "origin", "+refs/pull/42/head:refs/reviewer/pr/1/42"],
      expect.any(Object),
    );

    expect(mockSpawn).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "--detach", wt.cwd, "test_sha"],
      expect.any(Object),
    );

    await wt.cleanup();
    expect(mockSpawn).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "--force", wt.cwd],
      expect.any(Object),
    );
  });

  it("fails if fetched SHA mismatches", async () => {
    setupGitMock({
      "rev-parse ref": "wrong_sha",
    });

    const repo = { id: 1, owner: "o", name: "n", local_path: "/local" } as any;
    const pr = { number: 42, head_sha: "test_sha" };

    await expect(preparePrHeadWorktree({ repo, pr })).rejects.toThrow(/does not match/);
  });

  it("terminates cleanup that exceeds its time budget", async () => {
    vi.useFakeTimers();
    let invocation = 0;
    let cleanupChild: any;
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      invocation++;
      const ee: any = new EventEmitter();
      ee.stdout = new EventEmitter();
      ee.stderr = new EventEmitter();
      ee.stdin = { end: vi.fn(), write: vi.fn() };
      ee.kill = vi.fn();
      ee.pid = 999_999_000 + invocation;

      if (invocation < 4) {
        const out = args[0] === "rev-parse" ? "test_sha" : "";
        queueMicrotask(() => {
          ee.stdout.emit("data", Buffer.from(out));
          ee.emit("close", 0);
        });
      } else {
        cleanupChild = ee;
      }
      return ee;
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const wt = await preparePrHeadWorktree({
      repo: { id: 1, owner: "o", name: "n", local_path: "/local" } as any,
      pr: { number: 42, head_sha: "test_sha" },
    });
    const cleanup = wt.cleanup();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(cleanupChild.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(2_000);
    await cleanup;
    expect(cleanupChild.kill).toHaveBeenCalledWith("SIGKILL");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("timed out after 30000ms"));
    cleanupChild.emit("close", null);
    errorSpy.mockRestore();
  });

  it("prunes worktrees", async () => {
    setupGitMock({});
    const repos = [
      { id: 1, local_path: "/local1" },
      { id: 2, local_path: "/local2" },
    ] as any;
    await pruneWorktrees(repos);
    expect(mockSpawn).toHaveBeenCalledWith(
      "git",
      ["worktree", "prune"],
      expect.objectContaining({ cwd: "/local1" }),
    );
    expect(mockSpawn).toHaveBeenCalledWith(
      "git",
      ["worktree", "prune"],
      expect.objectContaining({ cwd: "/local2" }),
    );
    expect(rm).toHaveBeenCalledWith("/data/worktrees", expect.any(Object));
  });

  it("prunes only stale Reviewer worktrees", async () => {
    setupGitMock({});
    vi.mocked(readdir).mockResolvedValue([
      { name: "old-review", isDirectory: () => true },
      { name: "active-review", isDirectory: () => true },
    ] as any);
    vi.mocked(stat)
      .mockResolvedValueOnce({ mtimeMs: 0 } as any)
      .mockResolvedValueOnce({ mtimeMs: Date.now() } as any);
    const repo = { id: 1, local_path: "/local" } as any;

    await expect(pruneStaleWorktrees([repo], 1_000)).resolves.toBe(1);

    expect(mockSpawn).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "--force", "/data/worktrees/repo-1/old-review"],
      expect.any(Object),
    );
    expect(mockSpawn).not.toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "--force", "/data/worktrees/repo-1/active-review"],
      expect.any(Object),
    );
  });
});
