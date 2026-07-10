import { describe, it, expect, vi, beforeEach } from "vitest";
import { preparePrHeadWorktree } from "./prWorktree.js";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
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
  });

  function setupGitMock(responses: Record<string, string>) {
    mockSpawn.mockImplementation((cmd: string, args: string[]) => {
      const ee: any = new EventEmitter();
      ee.stdout = new EventEmitter();
      ee.stderr = new EventEmitter();
      
      const fullArgs = args.join(" ");
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
    expect(wt.cwd).toContain("/data/worktrees/repo-1/pr-42-test_sha");

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
  });

  it("fails if fetched SHA mismatches", async () => {
    setupGitMock({
      "rev-parse ref": "wrong_sha",
    });

    const repo = { id: 1, owner: "o", name: "n", local_path: "/local" } as any;
    const pr = { number: 42, head_sha: "test_sha" };

    await expect(preparePrHeadWorktree({ repo, pr })).rejects.toThrow(/does not match/);
  });
});
