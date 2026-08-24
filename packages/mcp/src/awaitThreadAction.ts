import type { ThreadActionRow } from "@reviewer/server/api";
import { resolveThreadActionStatus, type ThreadActionStatus } from "./threadActionStatus.js";
import { createDurableProgressReporter, type DurableProgressContext } from "./progress.js";

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

export type AwaitThreadActionContext = DurableProgressContext;

export async function handleAwaitThreadAction(
  args: { actionId: number; timeoutMs: number },
  context: AwaitThreadActionContext,
  deps: AwaitThreadActionDeps,
): Promise<ThreadActionStatus> {
  const action = await deps.waitForThreadAction(args.actionId, {
    signal: context.signal,
    timeoutMs: args.timeoutMs,
    onProgress: createDurableProgressReporter(context, "Thread action"),
  });
  return resolveThreadActionStatus(action);
}
