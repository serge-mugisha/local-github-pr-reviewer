import { describe, expect, it } from "vitest";
import type { ReviewRow } from "@reviewer/server/api";
import { reconcileReviewJob, type Job } from "./jobStatus.js";

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
