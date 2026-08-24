import type { ReviewRow } from "@reviewer/server/api";
import { resolveJobStatus, type Job } from "./jobStatus.js";

export interface AwaitReviewDeps {
  waitForReview(
    reviewId: number,
    options: {
      signal?: AbortSignal;
      timeoutMs: number;
      onProgress(review: ReviewRow): void;
    },
  ): Promise<ReviewRow>;
  getReview(reviewId: number): ReviewRow | undefined;
  getThreads(prId: number): unknown[];
  reconcileInterruptedReviews(): void;
}

export interface AwaitReviewContext {
  signal?: AbortSignal;
  progressToken?: string | number;
  sendProgress(params: {
    progressToken: string | number;
    progress: number;
    message: string;
  }): void | Promise<void>;
}

export async function handleAwaitReview(
  args: { reviewId: number; timeoutMs: number },
  context: AwaitReviewContext,
  deps: AwaitReviewDeps,
): Promise<Job> {
  let lastProgressAt = 0;
  await deps.waitForReview(args.reviewId, {
    signal: context.signal,
    timeoutMs: args.timeoutMs,
    onProgress: (review) => {
      const timestamp = Date.now();
      if (context.progressToken === undefined || timestamp - lastProgressAt < 10_000) return;
      lastProgressAt = timestamp;
      const elapsedSeconds = Math.max(
        0,
        Math.round((timestamp - Date.parse(review.started_at)) / 1_000),
      );
      void Promise.resolve(
        context.sendProgress({
          progressToken: context.progressToken,
          progress: elapsedSeconds,
          message: `Review ${review.id} is healthy and still running (${elapsedSeconds}s elapsed).`,
        }),
      ).catch(() => {
        // The review continues durably if this client disconnects.
      });
    },
  });

  return resolveJobStatus(
    { reviewId: args.reviewId },
    {
      getJob: () => undefined,
      getReview: deps.getReview,
      getThreads: deps.getThreads,
      reconcileInterruptedReviews: deps.reconcileInterruptedReviews,
    },
  );
}
