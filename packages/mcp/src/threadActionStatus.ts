import type { ThreadActionRow } from "@reviewer/server/api";

export interface ThreadActionStatus {
  actionId: number;
  threadId: number;
  prId: number;
  type: "reply" | "revalidate";
  status: "running" | "completed" | "error";
  result?: unknown;
  error?: string;
  startedAt: string;
  completedAt?: string;
  statusMessage?: string;
  nextAction?: string;
}

export function selectThreadAction(
  request: { actionId?: number; threadId?: number },
  deps: {
    getById(actionId: number): ThreadActionRow | undefined;
    getLatestForThread(threadId: number): ThreadActionRow | undefined;
  },
): ThreadActionRow {
  const action =
    request.actionId === undefined
      ? deps.getLatestForThread(request.threadId!)
      : deps.getById(request.actionId);
  if (!action) {
    throw new Error(
      request.actionId === undefined
        ? `No thread action found for thread ${request.threadId}`
        : `Thread action ${request.actionId} not found`,
    );
  }
  if (request.threadId !== undefined && action.thread_id !== request.threadId) {
    throw new Error(
      `Thread action ${action.id} belongs to thread ${action.thread_id}, not ${request.threadId}`,
    );
  }
  return action;
}

export function resolveThreadActionStatus(action: ThreadActionRow): ThreadActionStatus {
  const status: ThreadActionStatus = {
    actionId: action.id,
    threadId: action.thread_id,
    prId: action.pr_id,
    type: action.kind,
    status:
      action.status === "done" ? "completed" : action.status === "error" ? "error" : "running",
    startedAt: action.started_at,
  };

  if (action.status === "done") {
    status.completedAt = action.finished_at ?? undefined;
    status.result = action.result === null ? null : JSON.parse(action.result);
  } else if (action.status === "error") {
    status.completedAt = action.finished_at ?? undefined;
    status.error = action.error ?? "Thread action failed.";
  } else {
    const elapsedSeconds = Math.max(
      0,
      Math.round((Date.now() - Date.parse(action.started_at)) / 1_000),
    );
    status.statusMessage = `Thread action ${action.id} is healthy and still running (${elapsedSeconds}s elapsed; last heartbeat ${action.heartbeat_at ?? "pending"}).`;
    status.nextAction =
      "After a transport timeout, retry the original reply_to_thread or revalidate_thread once with identical arguments to join this active action. Do not call await_thread_action, poll, or start a different action on this thread.";
  }

  return status;
}
