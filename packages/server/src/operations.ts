import { createHash } from "node:crypto";
import {
  getDb,
  getRepo,
  type PrRow,
  type RepoRow,
  type ThreadRow,
  type WorkItemRow,
} from "./db.js";
import { getGlobalReviewConfig, getPrReviewConfig, type ReviewConfig } from "./reviewConfig.js";
import { getSkills } from "./skills.js";
import { hydratePR, getPRById, listThreadsForPR } from "./prs.js";
import { resolveReviewerProvider } from "./reviewerProvider.js";
import {
  ensureWorkItemRunning,
  findLatestWorkItem,
  waitForWorkItem,
  type ReviewExecutionSnapshot,
  type WorkPayload,
} from "./workQueue.js";

export const OPERATION_POLL_INTERVAL_MS = 20_000;
export const MAX_OPERATION_WAIT_MS = 25_000;

export type OperationStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type ReviewGate = "pending" | "clean" | "findings" | "stale" | "failed";

export interface OperationSnapshot {
  operationId: string;
  kind: WorkItemRow["kind"];
  status: OperationStatus;
  terminal: boolean;
  phase: string;
  created: boolean;
  target: { prId?: number; threadId?: number };
  headSha: string | null;
  baseSha: string | null;
  provider: string | null;
  configFingerprint: string | null;
  createdAt: string;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  finishedAt: string | null;
  expiresAt: string | null;
  attempt: number;
  statusMessage: string;
  retryAfterMs?: number;
  nextAction?: { tool: "wait_operation"; arguments: { operationId: string; waitMs: number } };
  result?: unknown;
  error?: string;
  review?: {
    reviewId?: number;
    reviewedHeadSha: string | null;
    currentHeadSha: string | null;
    gate: ReviewGate;
    summary: string | null;
    findings: unknown[];
    openActionableThreads: unknown[];
  };
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function loadOpenThreadContext(prId: number): ReviewExecutionSnapshot["openThreads"] {
  const rows = getDb()
    .prepare(
      `SELECT t.*, c.body AS first_body
       FROM threads t
       LEFT JOIN comments c ON c.id = (
         SELECT id FROM comments WHERE thread_id = t.id ORDER BY id ASC LIMIT 1
       )
       WHERE t.pr_id = ? AND t.status = 'open'
       ORDER BY t.id`,
    )
    .all(prId) as (ThreadRow & { first_body: string | null })[];
  return rows.map((thread) => ({
    id: thread.id,
    path: thread.file_path,
    line: thread.line,
    summary: (thread.first_body ?? "").slice(0, 200),
    lastSeenSha: thread.last_seen_sha,
  }));
}

export async function createReviewExecutionSnapshot(
  repo: RepoRow,
  pr: PrRow,
  expectedHeadSha?: string,
  prConfigOverride?: Partial<ReviewConfig>,
): Promise<ReviewExecutionSnapshot> {
  const refreshed = await hydratePR(repo, pr.number);
  if (expectedHeadSha && refreshed.head_sha !== expectedHeadSha) {
    throw new Error(
      `PR head changed before review enqueue: expected ${expectedHeadSha}, current ${refreshed.head_sha}.`,
    );
  }
  const skills = getSkills(repo.id);
  const prConfig = { ...getPrReviewConfig(refreshed.id), ...prConfigOverride };
  const globalConfig = getGlobalReviewConfig();
  const providerId = resolveReviewerProvider(repo, refreshed).provider;
  const config = {
    categories: prConfig.categories,
    strictness: prConfig.strictness,
    globalRules: globalConfig.customRules,
    repoRules: skills,
    perPrRules: prConfig.customRules,
    pathInclude: prConfig.pathInclude,
    pathExclude: prConfig.pathExclude,
  };
  const openThreads = loadOpenThreadContext(refreshed.id);
  const configFingerprint = hash({
    pr: {
      id: refreshed.id,
      number: refreshed.number,
      title: refreshed.title,
      body: refreshed.body,
      headSha: refreshed.head_sha,
      baseSha: refreshed.base_sha,
    },
    providerId,
    skills,
    config,
    openThreads,
  });
  return { pr: refreshed, providerId, skills, config, openThreads, configFingerprint };
}

export function reviewIdempotencyKey(snapshot: ReviewExecutionSnapshot): string {
  return `review:${snapshot.pr.id}:${snapshot.configFingerprint}`;
}

export function threadActionIdempotencyKey(
  kind: "reply" | "revalidate",
  threadId: number,
  input: {
    headSha: string;
    providerId: string;
    contextVersion: string;
    message?: string;
  },
): string {
  return `${kind}:${threadId}:${hash(input)}`;
}

export function getThreadActionContextVersion(threadId: number): string {
  const row = getDb()
    .prepare(
      `SELECT t.status, COALESCE(MAX(c.id), 0) AS latest_comment_id
       FROM threads t
       LEFT JOIN comments c ON c.thread_id = t.id
       WHERE t.id = ?
       GROUP BY t.id`,
    )
    .get(threadId) as { status: string; latest_comment_id: number } | undefined;
  if (!row) throw new Error(`Thread ${threadId} not found.`);
  return `${row.status}:${row.latest_comment_id}`;
}

function canonicalStatus(status: WorkItemRow["status"]): OperationStatus {
  if (status === "done") return "completed";
  if (status === "error") return "failed";
  return status;
}

function targetFromPayload(payload: WorkPayload): OperationSnapshot["target"] {
  return payload.kind === "review" ? { prId: payload.prId } : { threadId: payload.threadId };
}

function reviewResult(
  work: WorkItemRow,
  payload: WorkPayload,
): OperationSnapshot["review"] | undefined {
  if (payload.kind !== "review") return undefined;
  const currentPr = getPRById(payload.prId);
  let relatedId = work.related_id ?? null;
  if (!relatedId && work.result) {
    try {
      const legacyResult = JSON.parse(work.result) as { reviewId?: unknown };
      const parsed = Number(legacyResult.reviewId);
      if (Number.isInteger(parsed) && parsed > 0) relatedId = parsed;
    } catch {
      // A malformed historical payload is represented by the failed gate below.
    }
  }
  if (work.status !== "done" || !relatedId) {
    return {
      reviewedHeadSha: work.head_sha ?? null,
      currentHeadSha: currentPr?.head_sha ?? null,
      gate: work.status === "error" || work.status === "cancelled" ? "failed" : "pending",
      summary: null,
      findings: [],
      openActionableThreads: [],
    };
  }
  const review = getDb().prepare("SELECT * FROM reviews WHERE id = ?").get(relatedId) as
    | { id: number; pr_id: number; head_sha: string; summary: string | null; result: string | null }
    | undefined;
  if (!review) {
    return {
      reviewedHeadSha: work.head_sha ?? null,
      currentHeadSha: currentPr?.head_sha ?? null,
      gate: "failed",
      summary: null,
      findings: [],
      openActionableThreads: [],
    };
  }
  const findings = review.result
    ? ((JSON.parse(review.result) as { comments?: unknown[] }).comments ?? [])
    : [];
  const openActionableThreads = listThreadsForPR(review.pr_id).filter(
    (thread) =>
      thread.status === "open" && !thread.stale && thread.last_seen_sha === review.head_sha,
  );
  const gate: ReviewGate =
    currentPr?.head_sha !== review.head_sha
      ? "stale"
      : openActionableThreads.length > 0
        ? "findings"
        : "clean";
  return {
    reviewId: review.id,
    reviewedHeadSha: review.head_sha,
    currentHeadSha: currentPr?.head_sha ?? null,
    gate,
    summary: review.summary,
    findings,
    openActionableThreads,
  };
}

export function operationSnapshot(work: WorkItemRow, created = false): OperationSnapshot {
  const payload = JSON.parse(work.payload) as WorkPayload;
  const status = canonicalStatus(work.status);
  const terminal = status === "completed" || status === "failed" || status === "cancelled";
  const result = work.result ? (JSON.parse(work.result) as unknown) : undefined;
  const review = reviewResult(work, payload);
  const statusMessage =
    status === "queued"
      ? "Queued for the detached Reviewer worker."
      : status === "running"
        ? `Reviewer is ${(work.phase ?? "running").replaceAll("_", " ")} (attempt ${work.attempt_count}).`
        : status === "completed"
          ? "Reviewer operation completed."
          : (work.error ?? `Reviewer operation ${status}.`);
  return {
    operationId: work.id,
    kind: work.kind,
    status,
    terminal,
    phase: work.phase ?? work.status,
    created,
    target: targetFromPayload(payload),
    headSha: work.head_sha ?? null,
    baseSha: work.base_sha ?? null,
    provider: work.provider ?? null,
    configFingerprint: work.config_fingerprint ?? null,
    createdAt: work.created_at,
    startedAt: work.started_at,
    lastHeartbeatAt: work.heartbeat_at,
    finishedAt: work.finished_at,
    expiresAt: work.expires_at ?? null,
    attempt: work.attempt_count,
    statusMessage,
    ...(terminal
      ? {}
      : {
          retryAfterMs: OPERATION_POLL_INTERVAL_MS,
          nextAction: {
            tool: "wait_operation" as const,
            arguments: { operationId: work.id, waitMs: OPERATION_POLL_INTERVAL_MS },
          },
        }),
    ...(result === undefined ? {} : { result }),
    ...(work.error ? { error: work.error } : {}),
    ...(review ? { review } : {}),
  };
}

export function getOperation(operationId: string): OperationSnapshot {
  return operationSnapshot(ensureWorkItemRunning(operationId));
}

export async function waitOperation(
  operationId: string,
  waitMs = OPERATION_POLL_INTERVAL_MS,
  signal?: AbortSignal,
): Promise<OperationSnapshot> {
  const boundedWait = Math.max(0, Math.min(waitMs, MAX_OPERATION_WAIT_MS));
  let work: WorkItemRow;
  try {
    work = await waitForWorkItem(operationId, {
      signal,
      timeoutMs: boundedWait,
      returnOnTimeout: true,
    });
  } catch (error) {
    const terminal = ensureWorkItemRunning(operationId);
    if (terminal.status !== "error" && terminal.status !== "cancelled") throw error;
    work = terminal;
  }
  return operationSnapshot(work);
}

export function getLatestOperation(
  kind: WorkPayload["kind"],
  targetId: number,
): OperationSnapshot | undefined {
  const work = findLatestWorkItem(kind, targetId);
  return work ? operationSnapshot(work) : undefined;
}

export async function verifyReviewGate(operationId: string): Promise<OperationSnapshot> {
  const work = ensureWorkItemRunning(operationId);
  if (work.kind !== "review") throw new Error("Only review operations have an exact-head gate.");
  const payload = JSON.parse(work.payload) as Extract<WorkPayload, { kind: "review" }>;
  const pr = getPRById(payload.prId);
  if (!pr) throw new Error(`PR ${payload.prId} not found.`);
  const repo = getRepo(pr.repo_id);
  if (!repo) throw new Error(`Repository ${pr.repo_id} not found.`);
  await hydratePR(repo, pr.number);
  return operationSnapshot(ensureWorkItemRunning(operationId));
}
