import { spawn, spawnSync } from "node:child_process";
import type { ProviderProgress } from "./types.js";

const MAX_FAILURE_OUTPUT_CHARS = 64 * 1024;

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
  signal?: AbortSignal;
}

export class CliTimeoutError extends Error {
  override name = "CliTimeoutError";
}

function killProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    // Providers can spawn helpers that inherit stdout/stderr. Killing only the
    // direct child can leave those pipes open forever, so use a process group
    // on POSIX and fall back to the direct child on Windows.
    if (process.platform === "win32") {
      spawnSync(
        "taskkill",
        ["/PID", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])],
        { stdio: "ignore", windowsHide: true },
      );
    } else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process already exited.
    }
  }
}

const activeCliChildren = new Set<ReturnType<typeof spawn>>();
export function terminateActiveCliChildren(signal: NodeJS.Signals = "SIGTERM"): void {
  for (const child of activeCliChildren) killProcessTree(child, signal);
}

export async function shutdownActiveCliChildren(graceMs = 2_000): Promise<void> {
  // Snapshot the group leaders: their direct processes may close after
  // SIGTERM and disappear from the active set while stubborn descendants in
  // the same groups remain alive.
  const processGroups = [...activeCliChildren];
  for (const child of processGroups) killProcessTree(child, "SIGTERM");
  if (processGroups.length === 0) return;
  await new Promise<void>((resolveP) => setTimeout(resolveP, graceMs));
  for (const child of processGroups) killProcessTree(child, "SIGKILL");
}
process.once("exit", () => terminateActiveCliChildren());

export function spawnCli(opts: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolveP, rejectP) => {
    if (opts.signal?.aborted) {
      rejectP(opts.signal.reason ?? new Error(`${opts.cmd} was cancelled`));
      return;
    }
    const child = spawn(opts.cmd, opts.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    activeCliChildren.add(child);
    let stdout = "";
    let stderr = "";
    let combinedOutput = "";
    let timer: NodeJS.Timeout | null = null;
    let forceKillTimer: NodeJS.Timeout | null = null;
    let settled = false;
    let cancellationError: Error | null = null;

    const clearTimers = () => {
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };

    const finish = (result: SpawnResult) => {
      if (settled || cancellationError) return;
      settled = true;
      activeCliChildren.delete(child);
      clearTimers();
      resolveP(result);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      // Keep timed-out children registered until their close event so a
      // parent exit during the SIGTERM grace period still kills the group.
      if (error.name !== "CliTimeoutError") activeCliChildren.delete(child);
      clearTimers();
      rejectP(error);
    };

    const terminateAfterGrace = (error: Error) => {
      if (settled || cancellationError) return;
      cancellationError = error;
      if (timer) clearTimeout(timer);
      killProcessTree(child, "SIGTERM");
      // Hold the provider promise and therefore its review lease through the
      // grace period. The direct child may exit while a descendant ignores
      // SIGTERM, so only settle after process-group SIGKILL has run.
      forceKillTimer = setTimeout(() => {
        killProcessTree(child, "SIGKILL");
        activeCliChildren.delete(child);
        fail(cancellationError!);
      }, 2_000);
      forceKillTimer.unref?.();
    };
    const onAbort = () => {
      terminateAfterGrace(
        opts.signal?.reason instanceof Error
          ? opts.signal.reason
          : new Error(String(opts.signal?.reason ?? `${opts.cmd} was cancelled`)),
      );
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        terminateAfterGrace(new CliTimeoutError(`${opts.cmd} timed out after ${opts.timeoutMs}ms`));
      }, opts.timeoutMs);
      timer.unref?.();
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
      // A direct parent can close while descendants in its process group are
      // still alive. Retain the group leader through a pending escalation so
      // process shutdown can still find and kill that group.
      if (!forceKillTimer) activeCliChildren.delete(child);
      opts.signal?.removeEventListener("abort", onAbort);
      finish({ stdout, stderr, combinedOutput, exitCode: code ?? -1 });
    });
    child.on("error", (e) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (cancellationError) return;
      fail(e);
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
  let output = (
    result.combinedOutput || [result.stderr, result.stdout].filter(Boolean).join("\n")
  ).trim();
  if (output.length > MAX_FAILURE_OUTPUT_CHARS) {
    const keptAtEachEnd = MAX_FAILURE_OUTPUT_CHARS / 2;
    const omitted = output.length - MAX_FAILURE_OUTPUT_CHARS;
    output = `${output.slice(0, keptAtEachEnd)}\n\n… ${omitted} characters omitted …\n\n${output.slice(-keptAtEachEnd)}`;
  }
  return output
    ? `${command} ${reason}\n\n${output}`
    : `${command} ${reason}. The CLI wrote nothing to stdout or stderr.`;
}

export function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolveP) => {
    const child = spawn("which", [cmd], { stdio: ["ignore", "ignore", "ignore"] });
    child.on("close", (code) => resolveP(code === 0));
    child.on("error", () => resolveP(false));
  });
}
