import { describe, expect, it, vi } from "vitest";
import type { ThreadActionRow } from "@reviewer/server/api";
import { handleAwaitThreadAction, type AwaitThreadActionDeps } from "./awaitThreadAction.js";

function action(status: ThreadActionRow["status"]): ThreadActionRow {
  return {
    id: 17,
    thread_id: 9,
    pr_id: 4,
    kind: "reply",
    input: "context",
    provider: "codex",
    status,
    result: status === "done" ? JSON.stringify({ aiCommentId: 22 }) : null,
    started_at: new Date(Date.now() - 30_000).toISOString(),
    heartbeat_at: new Date().toISOString(),
    finished_at: status === "done" ? new Date().toISOString() : null,
    error: null,
    worker_token: "worker",
    worker_pid: process.pid,
  };
}

describe("await_thread_action handler", () => {
  it("returns persisted completion after restart and emits progress", async () => {
    const done = action("done");
    const waitForThreadAction = vi.fn(async (_actionId, options) => {
      options.onProgress(action("running"));
      return done;
    });
    const sendProgress = vi.fn();
    const signal = new AbortController().signal;
    const deps: AwaitThreadActionDeps = { waitForThreadAction };

    const result = await handleAwaitThreadAction(
      { actionId: 17, timeoutMs: 1_000 },
      { signal, progressToken: "progress-1", sendProgress },
      deps,
    );

    expect(waitForThreadAction).toHaveBeenCalledWith(
      17,
      expect.objectContaining({ signal, timeoutMs: 1_000, onProgress: expect.any(Function) }),
    );
    expect(sendProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        progressToken: "progress-1",
        message: expect.stringContaining("healthy"),
      }),
    );
    expect(result).toMatchObject({
      actionId: 17,
      status: "completed",
      result: { aiCommentId: 22 },
    });
  });

  it("forwards request cancellation to the durable wait", async () => {
    const controller = new AbortController();
    controller.abort(new Error("client disconnected"));
    const waitForThreadAction = vi.fn(async (_actionId, options) => {
      throw options.signal?.reason;
    });

    await expect(
      handleAwaitThreadAction(
        { actionId: 17, timeoutMs: 1_000 },
        { signal: controller.signal, sendProgress: vi.fn() },
        { waitForThreadAction },
      ),
    ).rejects.toThrow("client disconnected");
    expect(waitForThreadAction).toHaveBeenCalledWith(
      17,
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
