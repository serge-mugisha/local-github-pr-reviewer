import { getDb, getRepo } from "./db.js";
import { getPRById } from "./prs.js";
import { resolveReviewerProvider } from "./reviewerProvider.js";
import { startReply, startReview, startRevalidate } from "./review.js";
import {
  appendWorkEvent,
  claimWorkItem,
  completeWorkItem,
  failWorkItem,
  startWorkHeartbeat,
  type WorkPayload,
} from "./workQueue.js";

function requireContext(prId: number) {
  const pr = getPRById(prId);
  if (!pr) throw new Error(`PR ${prId} not found.`);
  const repo = getRepo(pr.repo_id);
  if (!repo) throw new Error(`Repository ${pr.repo_id} not found.`);
  return { pr, repo, providerId: resolveReviewerProvider(repo, pr).provider };
}

async function execute(workId: string, payload: WorkPayload): Promise<unknown> {
  const onProgress = (event: Parameters<typeof appendWorkEvent>[1]) =>
    appendWorkEvent(workId, event);
  if (payload.kind === "review") {
    const context = requireContext(payload.prId);
    return startReview({ ...context, onProgress }).completion;
  }
  const thread = getDb().prepare("SELECT pr_id FROM threads WHERE id = ?").get(payload.threadId) as
    | { pr_id: number }
    | undefined;
  if (!thread) throw new Error(`Thread ${payload.threadId} not found.`);
  const context = requireContext(thread.pr_id);
  if (payload.kind === "reply") {
    return startReply({
      ...context,
      threadId: payload.threadId,
      userMessage: payload.message,
      userMessageAlreadyPersisted: true,
      onProgress,
    }).completion;
  }
  return startRevalidate({ ...context, threadId: payload.threadId, onProgress }).completion;
}

async function main(): Promise<void> {
  const workId = process.argv[2];
  if (!workId) throw new Error("Reviewer worker requires a work item ID.");
  const claim = claimWorkItem(workId);
  if (!claim) return;
  const stopHeartbeat = startWorkHeartbeat(workId, claim.workerToken);
  try {
    const payload = JSON.parse(claim.row.payload) as WorkPayload;
    const result = await execute(workId, payload);
    completeWorkItem(workId, claim.workerToken, result);
  } catch (error) {
    failWorkItem(workId, claim.workerToken, error);
    process.exitCode = 1;
  } finally {
    stopHeartbeat();
  }
}

void main();
