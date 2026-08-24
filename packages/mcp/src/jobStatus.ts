import type { ReviewRow } from "@reviewer/server/api";

export interface Job {
  id?: number;
  status: "running" | "completed" | "error";
  result?: unknown;
  error?: string;
  type: string;
  reviewId?: number;
  prId?: number;
  startedAt: string;
  completedAt?: string;
  statusMessage?: string;
  nextAction?: string;
}

export interface JobStatusQuery {
  jobId?: number;
  reviewId?: number;
}

export interface JobStatusDeps {
  getJob(jobId: number): Job | undefined;
  getReview(reviewId: number): ReviewRow | undefined;
  getThreads(prId: number): unknown[];
  reconcileInterruptedReviews(): void;
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
      addedThreads: review.added_threads,
      staleMarked: review.stale_marked,
      threadsReady: true,
    };
    delete next.error;
  } else if (review.status === "error") {
    next.status = "error";
    next.completedAt = review.finished_at ?? next.completedAt;
    next.error = review.error ?? "Review failed.";
  } else {
    next.status = "running";
    const elapsedSeconds = Math.max(
      0,
      Math.round((Date.now() - Date.parse(review.started_at)) / 1_000),
    );
    next.statusMessage = `Review ${review.id} is healthy and still running (${elapsedSeconds}s elapsed; last heartbeat ${review.heartbeat_at ?? "pending"}).`;
    next.nextAction =
      "Call await_review once with this reviewId. Do not poll get_job_status or trigger another review.";
  }

  return next;
}

export function resolveJobStatus(query: JobStatusQuery, deps: JobStatusDeps): Job {
  const existingJob = query.jobId === undefined ? undefined : deps.getJob(query.jobId);
  // A pre-0.4.1 positive job id was an unrelated in-memory counter, so an
  // uncached jobId must never be guessed to be a persisted review id. The
  // explicit reviewId is the restart-safe handle returned by trigger_review.
  const reviewId = query.reviewId ?? existingJob?.reviewId;

  if (reviewId !== undefined) {
    if (existingJob && existingJob.type !== "review") {
      throw new Error(`Job ${existingJob.id} is not a review`);
    }
    if (
      query.reviewId !== undefined &&
      existingJob?.reviewId !== undefined &&
      query.reviewId !== existingJob.reviewId
    ) {
      throw new Error(
        `Job ${existingJob.id} belongs to review ${existingJob.reviewId}, not ${query.reviewId}`,
      );
    }

    deps.reconcileInterruptedReviews();
    const review = deps.getReview(reviewId);
    if (!review) {
      if (existingJob && query.reviewId === undefined) return existingJob;
      throw new Error(`Review ${reviewId} not found`);
    }

    const baseJob: Job =
      existingJob ??
      ({
        status: "running",
        type: "review",
        reviewId: review.id,
        prId: review.pr_id,
        startedAt: review.started_at,
      } satisfies Job);
    const reconciled = reconcileReviewJob(baseJob, review);
    if (reconciled.status === "completed") {
      reconciled.result = {
        ...(reconciled.result as Record<string, unknown>),
        threads: deps.getThreads(review.pr_id),
      };
    }
    return reconciled;
  }

  if (!existingJob) throw new Error(`Job ${query.jobId} not found`);
  return existingJob;
}
