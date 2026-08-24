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
      "Call await_thread_action once with this actionId. Do not poll or start another action on this thread.";
  }

  return status;
}
