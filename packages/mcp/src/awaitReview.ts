import type { ReviewRow } from "@reviewer/server/api";
import { resolveJobStatus, type Job } from "./jobStatus.js";
import { createDurableProgressReporter, type DurableProgressContext } from "./progress.js";

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

export type AwaitReviewContext = DurableProgressContext;

export async function handleAwaitReview(
  args: { reviewId: number; timeoutMs: number },
  context: AwaitReviewContext,
  deps: AwaitReviewDeps,
): Promise<Job> {
  await deps.waitForReview(args.reviewId, {
    signal: context.signal,
    timeoutMs: args.timeoutMs,
    onProgress: createDurableProgressReporter(context, "Review"),
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
