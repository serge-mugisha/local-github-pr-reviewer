import { describe, expect, it, vi } from "vitest";
import type { ReviewRow } from "@reviewer/server/api";
import { handleAwaitReview, type AwaitReviewDeps } from "./awaitReview.js";

function review(status: "running" | "done"): ReviewRow {
  return {
    id: 41,
    pr_id: 7,
    head_sha: "head",
    provider: "codex",
    status,
    summary: status === "done" ? "Complete" : null,
    started_at: new Date(Date.now() - 30_000).toISOString(),
    heartbeat_at: new Date().toISOString(),
    finished_at: status === "done" ? new Date().toISOString() : null,
    error: null,
    worker_token: "worker",
    worker_pid: process.pid,
    added_threads: status === "done" ? 1 : null,
    stale_marked: status === "done" ? 0 : null,
  };
}

describe("await_review handler", () => {
  it("returns persisted threads after restart and emits progress", async () => {
    const done = review("done");
    const waitForReview = vi.fn(async (_reviewId, options) => {
      options.onProgress(review("running"));
      return done;
    });
    const sendProgress = vi.fn();
    const signal = new AbortController().signal;
    const deps: AwaitReviewDeps = {
      waitForReview,
      getReview: () => done,
      getThreads: () => [{ id: 99, body: "committed" }],
      reconcileInterruptedReviews: vi.fn(),
    };

    const result = await handleAwaitReview(
      { reviewId: 41, timeoutMs: 1_000 },
      { signal, progressToken: "progress-1", sendProgress },
      deps,
    );

    expect(waitForReview).toHaveBeenCalledWith(
      41,
      expect.objectContaining({ signal, timeoutMs: 1_000, onProgress: expect.any(Function) }),
    );
    expect(sendProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        progressToken: "progress-1",
        message: expect.stringContaining("healthy"),
      }),
    );
    expect(result).toMatchObject({
      status: "completed",
      reviewId: 41,
      result: { threadsReady: true, threads: [{ id: 99, body: "committed" }] },
    });
  });

  it("forwards request cancellation to the durable wait", async () => {
    const controller = new AbortController();
    controller.abort(new Error("client disconnected"));
    const waitForReview = vi.fn(async (_reviewId, options) => {
      throw options.signal?.reason;
    });

    await expect(
      handleAwaitReview(
        { reviewId: 41, timeoutMs: 1_000 },
        { signal: controller.signal, sendProgress: vi.fn() },
        {
          waitForReview,
          getReview: () => undefined,
          getThreads: () => [],
          reconcileInterruptedReviews: vi.fn(),
        },
      ),
    ).rejects.toThrow("client disconnected");
    expect(waitForReview).toHaveBeenCalledWith(
      41,
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
