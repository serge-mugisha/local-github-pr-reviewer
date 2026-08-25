import { describe, expect, it } from "vitest";
import type { ThreadActionRow } from "@reviewer/server/api";
import { resolveThreadActionStatus, selectThreadAction } from "./threadActionStatus.js";

function action(status: ThreadActionRow["status"]): ThreadActionRow {
  return {
    id: 17,
    thread_id: 9,
    pr_id: 4,
    kind: "revalidate",
    input: "",
    provider: "codex",
    status,
    result: status === "done" ? JSON.stringify({ resolved: true, commentId: 22 }) : null,
    started_at: new Date(Date.now() - 30_000).toISOString(),
    heartbeat_at: new Date().toISOString(),
    finished_at: status === "running" ? null : new Date().toISOString(),
    error: status === "error" ? "provider failed" : null,
    worker_token: "worker",
    worker_pid: process.pid,
  };
}

describe("resolveThreadActionStatus", () => {
  it("returns a parsed durable completion", () => {
    expect(resolveThreadActionStatus(action("done"))).toMatchObject({
      actionId: 17,
      threadId: 9,
      prId: 4,
      type: "revalidate",
      status: "completed",
      result: { resolved: true, commentId: 22 },
    });
  });

  it("surfaces persisted failure and running guidance", () => {
    expect(resolveThreadActionStatus(action("error"))).toMatchObject({
      status: "error",
      error: "provider failed",
    });
    expect(resolveThreadActionStatus(action("running"))).toMatchObject({
      status: "running",
      nextAction: expect.stringContaining("retry the original"),
    });
    expect(resolveThreadActionStatus(action("running")).nextAction).toContain(
      "Do not call await_thread_action",
    );
  });
});

describe("selectThreadAction", () => {
  it("recovers the latest persisted action by thread id", () => {
    const latest = action("done");
    expect(
      selectThreadAction(
        { threadId: 9 },
        { getById: () => undefined, getLatestForThread: () => latest },
      ),
    ).toBe(latest);
  });

  it("rejects an action id that belongs to another thread", () => {
    expect(() =>
      selectThreadAction(
        { actionId: 17, threadId: 10 },
        { getById: () => action("running"), getLatestForThread: () => undefined },
      ),
    ).toThrow("belongs to thread 9, not 10");
  });
});
