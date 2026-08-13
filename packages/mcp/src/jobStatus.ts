import type { ReviewRow } from "@reviewer/server/api";

export interface Job {
  id: number;
  status: "running" | "completed" | "error";
  result?: unknown;
  error?: string;
  type: string;
  reviewId?: number;
  prId?: number;
  startedAt: string;
  completedAt?: string;
}

export function reconcileReviewJob(job: Job, review: ReviewRow): Job {
  const next: Job = {
    ...job,
    type: "review",
    reviewId: review.id,
    prId: review.pr_id,
  };

  if (review.status === "done") {
    next.status = "completed";
    next.completedAt = review.finished_at ?? next.completedAt;
    next.result = {
      ...(typeof next.result === "object" && next.result !== null ? next.result : {}),
      reviewId: review.id,
      prId: review.pr_id,
      headSha: review.head_sha,
      summary: review.summary,
      finishedAt: review.finished_at,
      threadsReady: true,
    };
    delete next.error;
  } else if (review.status === "error") {
    next.status = "error";
    next.completedAt = review.finished_at ?? next.completedAt;
    next.error = review.error ?? "Review failed.";
  } else {
    next.status = "running";
  }

  return next;
}
