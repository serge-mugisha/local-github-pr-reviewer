import { describe, expect, it, vi } from "vitest";
import {
  formatCliFailure,
  shutdownActiveCliChildren,
  spawnCli,
  type SpawnResult,
} from "./spawn.js";

function result(partial: Partial<SpawnResult>): SpawnResult {
  return {
    stdout: "",
    stderr: "",
    combinedOutput: "",
    exitCode: 1,
    ...partial,
  };
}

describe("formatCliFailure", () => {
  it("preserves interleaved stdout and stderr without truncation", () => {
    const output = `stdout detail\n${"x".repeat(700)}\nstderr detail`;

    expect(formatCliFailure("claude", result({ combinedOutput: output }))).toBe(
      `claude exited 1\n\n${output}`,
    );
  });

  it("falls back to the separate streams for legacy results", () => {
    expect(
      formatCliFailure(
        "codex",
        result({ combinedOutput: "", stderr: "stderr detail", stdout: "stdout detail" }),
      ),
    ).toBe("codex exited 1\n\nstderr detail\nstdout detail");
  });

  it("explains when the CLI produced no error output", () => {
    expect(formatCliFailure("agy", result({}), "produced no assistant output")).toBe(
      "agy produced no assistant output. The CLI wrote nothing to stdout or stderr.",
    );
  });

  it("bounds pathological output while retaining its beginning and end", () => {
    const output = `important beginning\n${"x".repeat(70_000)}\nimportant end`;
    const message = formatCliFailure("claude", result({ combinedOutput: output }));

    expect(message).toContain("important beginning");
    expect(message).toContain("characters omitted");
    expect(message).toContain("important end");
    expect(message.length).toBeLessThan(66_000);
  });
});

describe("spawnCli timeout", () => {
  it("settles after escalation even when a descendant inherits the output pipes", async () => {
    const childScript = [
      "const { spawn } = require('node:child_process')",
      "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' })",
      "setInterval(() => {}, 1000)",
    ].join(";");
    const startedAt = Date.now();

    await expect(
      spawnCli({
        cmd: process.execPath,
        args: ["-e", childScript],
        cwd: process.cwd(),
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/timed out after 50ms/);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_900);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it("terminates active provider process groups during server shutdown", async () => {
    const running = spawnCli({
      cmd: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
    });

    await shutdownActiveCliChildren(50);

    const result = await running;
    expect(result.exitCode).not.toBe(0);
  });

  it("does not release a cancelled provider until stubborn descendants are killed", async () => {
    if (process.platform === "win32") return;
    const descendantScript = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
    const parentScript = [
      "const { spawn } = require('node:child_process')",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: 'ignore' })`,
      "console.log(child.pid)",
      "setInterval(() => {}, 1000)",
    ].join(";");
    const controller = new AbortController();
    let descendantPid = 0;
    const running = spawnCli({
      cmd: process.execPath,
      args: ["-e", parentScript],
      cwd: process.cwd(),
      signal: controller.signal,
      onProgress: (event) => {
        if (event.type === "stdout") descendantPid = Number(event.data.trim()) || descendantPid;
      },
    });

    await vi.waitFor(() => expect(descendantPid).toBeGreaterThan(0));
    controller.abort(new Error("review lifecycle expired"));
    await expect(running).rejects.toThrow("review lifecycle expired");
    await vi.waitFor(
      () => {
        expect(() => process.kill(descendantPid, 0)).toThrow();
      },
      { timeout: 1_000 },
    );
  });
});
