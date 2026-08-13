import { describe, expect, it, vi } from "vitest";
import type { ReviewRow } from "@reviewer/server/api";
import { reconcileReviewJob, resolveJobStatus, type Job, type JobStatusDeps } from "./jobStatus.js";

function job(): Job {
  return {
    id: 9,
    type: "review",
    status: "running",
    reviewId: 41,
    prId: 7,
    startedAt: "2026-08-13T00:00:00.000Z",
  };
}

function review(status: string): ReviewRow {
  return {
    id: 41,
    pr_id: 7,
    head_sha: "abc123",
    provider: "codex",
    status,
    summary: status === "done" ? "Complete" : null,
    started_at: "2026-08-13T00:00:00.000Z",
    heartbeat_at: "2026-08-13T00:00:05.000Z",
    finished_at: status === "running" ? null : "2026-08-13T00:03:30.000Z",
    error: status === "error" ? "provider failed" : null,
  };
}

describe("reconcileReviewJob", () => {
  it("treats persisted done state as canonical completion", () => {
    expect(reconcileReviewJob(job(), review("done"))).toMatchObject({
      status: "completed",
      completedAt: "2026-08-13T00:03:30.000Z",
      result: {
        reviewId: 41,
        prId: 7,
        headSha: "abc123",
        threadsReady: true,
      },
    });
  });

  it("surfaces a persisted review failure", () => {
    expect(reconcileReviewJob(job(), review("error"))).toMatchObject({
      status: "error",
      error: "provider failed",
      completedAt: "2026-08-13T00:03:30.000Z",
    });
  });

  it("leaves an active persisted review running", () => {
    expect(reconcileReviewJob(job(), review("running"))).toMatchObject({ status: "running" });
  });
});

describe("resolveJobStatus", () => {
  function deps(overrides: Partial<JobStatusDeps> = {}): JobStatusDeps {
    return {
      getJob: () => undefined,
      getReview: () => undefined,
      getThreads: () => [],
      reconcileInterruptedReviews: () => {},
      ...overrides,
    };
  }

  it("rejects non-review jobs and mismatched review ids", () => {
    const existing = job();
    expect(() =>
      resolveJobStatus(
        { jobId: existing.id, reviewId: 41 },
        deps({ getJob: () => ({ ...existing, type: "reply", reviewId: undefined }) }),
      ),
    ).toThrow("is not a review");
    expect(() =>
      resolveJobStatus({ jobId: existing.id, reviewId: 42 }, deps({ getJob: () => existing })),
    ).toThrow("belongs to review 41, not 42");
  });

  it("preserves a cached job when its persisted review was cleared", () => {
    const existing = { ...job(), status: "completed" as const, result: { reviewId: 41 } };
    expect(
      resolveJobStatus(
        { jobId: existing.id },
        deps({ getJob: () => existing, getReview: () => undefined }),
      ),
    ).toBe(existing);
  });

  it("recovers a completed review without inventing a job id", () => {
    const reconcile = vi.fn();
    const resolved = resolveJobStatus(
      { reviewId: 41 },
      deps({
        getReview: () => review("done"),
        getThreads: () => [{ id: 99 }],
        reconcileInterruptedReviews: reconcile,
      }),
    );

    expect(reconcile).toHaveBeenCalledOnce();
    expect(resolved.id).toBeUndefined();
    expect(resolved).toMatchObject({
      status: "completed",
      reviewId: 41,
      result: { reviewId: 41, threads: [{ id: 99 }] },
    });
  });

  it("reconciles a running persisted row before returning it", () => {
    const reconcile = vi.fn();
    resolveJobStatus(
      { reviewId: 41 },
      deps({ getReview: () => review("running"), reconcileInterruptedReviews: reconcile }),
    );
    expect(reconcile).toHaveBeenCalledOnce();
  });
});
