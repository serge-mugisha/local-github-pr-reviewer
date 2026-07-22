import { spawn } from "node:child_process";
import type { ProviderProgress } from "./types.js";

export interface SpawnResult {
  stdout: string;
  stderr: string;
  /** stdout and stderr chunks in the order they were observed. */
  combinedOutput: string;
  exitCode: number;
}

export interface SpawnOptions {
  cmd: string;
  args: string[];
  cwd: string;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  onProgress?: ProviderProgress;
  timeoutMs?: number;
}

export function spawnCli(opts: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(opts.cmd, opts.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let combinedOutput = "";
    let timer: NodeJS.Timeout | null = null;

    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2000);
      }, opts.timeoutMs);
    }

    child.stdout.on("data", (b) => {
      const s = b.toString();
      stdout += s;
      combinedOutput += s;
      opts.onProgress?.({ type: "stdout", data: s });
    });
    child.stderr.on("data", (b) => {
      const s = b.toString();
      stderr += s;
      combinedOutput += s;
      opts.onProgress?.({ type: "stderr", data: s });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolveP({ stdout, stderr, combinedOutput, exitCode: code ?? -1 });
    });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      rejectP(e);
    });

    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Formats a CLI failure without dropping either output stream. The fallback is
 * retained for mocked/legacy results that predate combinedOutput.
 */
export function formatCliFailure(
  command: string,
  result: SpawnResult,
  reason = `exited ${result.exitCode}`,
): string {
  const output = (
    result.combinedOutput || [result.stderr, result.stdout].filter(Boolean).join("\n")
  ).trim();
  return output
    ? `${command} ${reason}\n\n${output}`
    : `${command} ${reason} without producing error output.`;
}

export function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolveP) => {
    const child = spawn("which", [cmd], { stdio: ["ignore", "ignore", "ignore"] });
    child.on("close", (code) => resolveP(code === 0));
    child.on("error", () => resolveP(false));
  });
}
