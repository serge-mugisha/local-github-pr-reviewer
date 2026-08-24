import type { ThreadActionRow } from "@reviewer/server/api";
import { resolveThreadActionStatus, type ThreadActionStatus } from "./threadActionStatus.js";

export interface AwaitThreadActionDeps {
  waitForThreadAction(
    actionId: number,
    options: {
      signal?: AbortSignal;
      timeoutMs: number;
      onProgress(action: ThreadActionRow): void;
    },
  ): Promise<ThreadActionRow>;
}

export interface AwaitThreadActionContext {
  signal?: AbortSignal;
  progressToken?: string | number;
  sendProgress(params: {
    progressToken: string | number;
    progress: number;
    message: string;
  }): void | Promise<void>;
}

export async function handleAwaitThreadAction(
  args: { actionId: number; timeoutMs: number },
  context: AwaitThreadActionContext,
  deps: AwaitThreadActionDeps,
): Promise<ThreadActionStatus> {
  let lastProgressAt = 0;
  const action = await deps.waitForThreadAction(args.actionId, {
    signal: context.signal,
    timeoutMs: args.timeoutMs,
    onProgress: (current) => {
      const timestamp = Date.now();
      if (context.progressToken === undefined || timestamp - lastProgressAt < 10_000) return;
      lastProgressAt = timestamp;
      const elapsedSeconds = Math.max(
        0,
        Math.round((timestamp - Date.parse(current.started_at)) / 1_000),
      );
      void Promise.resolve(
        context.sendProgress({
          progressToken: context.progressToken,
          progress: elapsedSeconds,
          message: `Thread action ${current.id} is healthy and still running (${elapsedSeconds}s elapsed).`,
        }),
      ).catch(() => {
        // The action continues durably if this client disconnects.
      });
    },
  });
  return resolveThreadActionStatus(action);
}
