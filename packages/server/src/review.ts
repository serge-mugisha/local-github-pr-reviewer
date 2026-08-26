import {
  getDb,
  type PrRow,
  type RepoRow,
  type ThreadRow,
  type CommentRow,
  type ReviewRow,
  type ThreadActionRow,
} from "./db.js";
import { getProvider } from "./providers/index.js";
import { ReviewOutputParseError } from "./providers/parser.js";
import type {
  ProviderProgress,
  ReviewContext,
  ReviewResult,
  ReplyContext,
  RevalidateContext,
} from "./providers/types.js";
import { getSkills } from "./skills.js";
import { getPrReviewConfig, getGlobalReviewConfig } from "./reviewConfig.js";
import * as gh from "./github.js";
import { hydratePR } from "./prs.js";
import { recordSessions } from "./sessions.js";
import { preparePrHeadWorktree, type PrWorktree } from "./prWorktree.js";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  DURABLE_EXECUTION_TIMEOUT_MS,
  DURABLE_WAIT_TIMEOUT_MS,
  THREAD_ACTION_EXECUTION_TIMEOUT_MS,
} from "./timing.js";

function now(): string {
  return new Date().toISOString();
}

const configuredHeartbeatMs = Number(process.env.REVIEWER_HEARTBEAT_MS);
const DURABLE_HEARTBEAT_MS =
  Number.isFinite(configuredHeartbeatMs) && configuredHeartbeatMs >= 25
    ? configuredHeartbeatMs
    : 5_000;
const configuredStaleAfterMs = Number(process.env.REVIEWER_STALE_AFTER_MS);
const DURABLE_STALE_AFTER_MS =
  Number.isFinite(configuredStaleAfterMs) && configuredStaleAfterMs >= 250
    ? configuredStaleAfterMs
    : 30_000;
const DURABLE_POLL_INTERVAL_MS = 250;
const MAX_PROVIDER_OUTPUT_ATTEMPTS = 2;

function providerOutputExcerpt(raw: string, maxLength = 500): string {
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const excerpt = normalized.slice(0, maxLength);
  const suffix = normalized.length > maxLength ? "…" : "";
  return ` Output excerpt: ${JSON.stringify(`${excerpt}${suffix}`)}.`;
}

function reconcileInterruptedWork(
  db: Database.Database,
  table: "reviews" | "thread_actions",
  interruptedMessage: string,
): number {
  const finishedAt = now();
  const staleBefore = new Date(Date.now() - DURABLE_STALE_AFTER_MS).toISOString();
  const candidates = db
    .prepare(
      `SELECT id, worker_pid, heartbeat_at
       FROM ${table}
       WHERE status = 'running'
         AND (heartbeat_at IS NULL OR heartbeat_at < ?)`,
    )
    .all(staleBefore) as Array<{
    id: number;
    worker_pid: number | null;
    heartbeat_at: string | null;
  }>;
  const interrupt = db.prepare(
    `UPDATE ${table}
     SET status = 'error', finished_at = ?, error = ?
     WHERE id = ? AND status = 'running'`,
  );
  let changed = 0;
  for (const review of candidates) {
    // Heartbeat leases, not PIDs, define ownership. PIDs can be reused and a
    // live process can be wedged forever. Fencing a paused worker is safe: its
    // token can no longer publish when it resumes.
    changed += interrupt.run(finishedAt, interruptedMessage, review.id).changes;
  }
  return changed;
}

export function reconcileInterruptedReviews(db: Database.Database = getDb()): number {
  return reconcileInterruptedWork(db, "reviews", "Review interrupted before completion.");
}

function fingerprint(path: string | null, line: number | null, body: string): string {
  const head = body.replace(/\s+/g, " ").trim().slice(0, 200);
  return `${path ?? ""}|${line ?? ""}|${head}`;
}

export interface RunReviewArgs {
  repo: RepoRow;
  pr: PrRow;
  providerId: string;
  onProgress?: ProviderProgress;
  /** Runs only for the caller that wins the cross-process review claim. */
  beforeCreate?: () => void;
}

export interface RunReviewResult {
  reviewId: number;
  addedThreads: number;
  staleMarked: number;
}

export interface StartedReview {
  reviewId: number;
  created: boolean;
  completion: Promise<RunReviewResult>;
}

export interface ReviewClaimArgs {
  prId: number;
  headSha: string;
  providerId: string;
  startedAt: string;
  workerToken: string;
  workerPid: number;
  beforeClaim?: () => void;
  beforeCreate?: () => void;
}

/** The small, synchronous cross-process critical section for review ownership. */
export function claimReview(
  db: Database.Database,
  args: ReviewClaimArgs,
): { reviewId: number; created: boolean; workerToken?: string } {
  return db
    .transaction((): { reviewId: number; created: boolean; workerToken?: string } => {
      args.beforeClaim?.();
      const active = db
        .prepare(
          "SELECT id FROM reviews WHERE pr_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1",
        )
        .get(args.prId) as { id: number } | undefined;
      if (active) return { reviewId: active.id, created: false };

      args.beforeCreate?.();
      const reviewId = Number(
        db
          .prepare(
            `INSERT INTO reviews
               (pr_id, head_sha, provider, status, started_at, heartbeat_at, worker_token, worker_pid)
             VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`,
          )
          .run(
            args.prId,
            args.headSha,
            args.providerId,
            args.startedAt,
            args.startedAt,
            args.workerToken,
            args.workerPid,
          ).lastInsertRowid,
      );
      return { reviewId, created: true, workerToken: args.workerToken };
    })
    .immediate();
}

export interface WaitForReviewOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  pollIntervalMs?: number;
  onProgress?: (review: ReviewRow) => void;
}

const localJoinedWaiters = new Set<AbortController>();
const localReviewExecutions = new Set<AbortController>();
const localThreadActionWaiters = new Set<AbortController>();
const localThreadActionExecutions = new Set<AbortController>();

export function abortLocalReviewWork(
  reason: Error = new Error("Reviewer process is shutting down."),
): number {
  const controllers = new Set([
    ...localJoinedWaiters,
    ...localReviewExecutions,
    ...localThreadActionWaiters,
    ...localThreadActionExecutions,
  ]);
  for (const controller of controllers) controller.abort(reason);
  return controllers.size;
}

function waitForDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Review wait cancelled."));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Review wait cancelled."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForDurableWork<T extends { id: number; status: string; error: string | null }>(
  id: number,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    pollIntervalMs?: number;
    onProgress?: (work: T) => void;
  },
  deps: {
    label: string;
    activeDescription: string;
    reconcile(): void;
    get(): T | undefined;
  },
): Promise<T> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? DURABLE_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DURABLE_POLL_INTERVAL_MS;
  for (;;) {
    deps.reconcile();
    const work = deps.get();
    if (!work) throw new Error(`${deps.label} ${id} not found.`);
    if (work.status === "done") return work;
    if (work.status === "error") throw new Error(work.error ?? `${deps.label} ${id} failed.`);
    if (Date.now() - started >= timeoutMs) {
      throw new Error(
        `Timed out waiting for ${deps.label.toLowerCase()} ${id} after ${Math.ceil(timeoutMs / 1_000)} seconds; ${deps.activeDescription} remains active and can be awaited again safely.`,
      );
    }
    options.onProgress?.(work);
    await waitForDelay(pollIntervalMs, options.signal);
  }
}

/**
 * Wait on canonical persisted state rather than the provider promise owned by
 * one MCP process. This makes completion observable across reconnects and
 * returns as soon as the transaction publishing review results commits.
 */
export async function waitForReview(
  reviewId: number,
  options: WaitForReviewOptions = {},
): Promise<ReviewRow> {
  return waitForDurableWork(reviewId, options, {
    label: "Review",
    activeDescription: "the review",
    reconcile: reconcileInterruptedReviews,
    get: () => getReview(reviewId),
  });
}

function cleanupWorktreeInBackground(wt: PrWorktree): void {
  // Review results are usable once their transaction commits. Worktree removal
  // is housekeeping and must never delay that user-visible completion signal.
  void wt.cleanup().catch(() => {
    // Keep a future cleanup implementation from rejecting unhandled.
  });
}

export function startReview(args: RunReviewArgs): StartedReview {
  const { repo, pr, providerId, onProgress, beforeCreate } = args;
  const provider = getProvider(providerId);
  const db = getDb();

  // A SQLite write transaction is the cross-process lock. Every UI and MCP
  // server shares this database, so only the winner inserts and runs a
  // provider; all concurrent callers join the same durable review.
  const claim = claimReview(db, {
    prId: pr.id,
    headSha: pr.head_sha,
    providerId,
    startedAt: now(),
    workerToken: randomUUID(),
    workerPid: process.pid,
    beforeClaim: () => reconcileInterruptedReviews(db),
    beforeCreate,
  });

  if (!claim.created) {
    const waitController = new AbortController();
    localJoinedWaiters.add(waitController);
    return {
      ...claim,
      completion: waitForReview(claim.reviewId, { signal: waitController.signal })
        .then((review) => ({
          reviewId: claim.reviewId,
          addedThreads: review.added_threads ?? 0,
          staleMarked: review.stale_marked ?? 0,
        }))
        .finally(() => localJoinedWaiters.delete(waitController)),
    };
  }

  return {
    ...claim,
    completion: completeReview(
      { repo, pr, providerId, onProgress },
      claim.reviewId,
      claim.workerToken!,
      provider,
      db,
    ),
  };
}

export function runReview(args: RunReviewArgs): Promise<RunReviewResult> {
  return startReview(args).completion;
}

async function completeReview(
  args: RunReviewArgs,
  reviewId: number,
  workerToken: string,
  provider: ReturnType<typeof getProvider>,
  db: ReturnType<typeof getDb>,
): Promise<RunReviewResult> {
  const { repo, pr, providerId, onProgress } = args;
  const heartbeat = db.prepare(
    "UPDATE reviews SET heartbeat_at = ? WHERE id = ? AND worker_token = ? AND status = 'running'",
  );
  const heartbeatTimer = setInterval(() => {
    try {
      heartbeat.run(now(), reviewId, workerToken);
    } catch {
      // Transient DB contention must not terminate provider execution. The
      // lease and fenced terminal update still make prolonged failure safe.
    }
  }, DURABLE_HEARTBEAT_MS);

  const reviewFinish = db.prepare(`
    UPDATE reviews
    SET status = ?, summary = ?, finished_at = ?, error = ?,
        added_threads = ?, stale_marked = ?
    WHERE id = ? AND worker_token = ? AND status = 'running'
  `);
  const executionController = new AbortController();
  localReviewExecutions.add(executionController);
  const lifecycleError = new Error(
    `Review exceeded the ${Math.round(DURABLE_EXECUTION_TIMEOUT_MS / 60_000)}-minute total lifecycle limit.`,
  );
  const executionTimer = setTimeout(
    () => executionController.abort(lifecycleError),
    DURABLE_EXECUTION_TIMEOUT_MS,
  );
  executionTimer.unref?.();
  const assertLease = () => {
    const ownership = db
      .prepare("SELECT 1 FROM reviews WHERE id = ? AND worker_token = ? AND status = 'running'")
      .get(reviewId, workerToken);
    if (!ownership) throw new Error(`Review ${reviewId} lost its worker lease before publication.`);
  };

  try {
    const refreshed = await hydratePR(repo, pr.number, executionController.signal);
    assertLease();
    db.prepare("UPDATE reviews SET head_sha = ? WHERE id = ?").run(refreshed.head_sha, reviewId);
    const diff = await gh.getPRDiff(repo.owner, repo.name, pr.number, executionController.signal);
    assertLease();

    const skills = getSkills(repo.id);
    const prConfig = getPrReviewConfig(refreshed.id);
    const globalConfig = getGlobalReviewConfig();

    const existingOpen = db
      .prepare(
        `
      SELECT t.*, c.body AS first_body
      FROM threads t
      LEFT JOIN comments c ON c.id = (SELECT id FROM comments WHERE thread_id = t.id ORDER BY id ASC LIMIT 1)
      WHERE t.pr_id = ? AND t.status = 'open'
    `,
      )
      .all(refreshed.id) as (ThreadRow & { first_body: string | null })[];

    const wt = await preparePrHeadWorktree({
      repo,
      pr: refreshed,
      onProgress,
      signal: executionController.signal,
    });
    try {
      assertLease();
      const ctx: ReviewContext = {
        cwd: wt.cwd,
        prTitle: refreshed.title,
        prBody: refreshed.body,
        prNumber: refreshed.number,
        repoSlug: `${repo.owner}/${repo.name}`,
        headSha: refreshed.head_sha,
        baseSha: refreshed.base_sha,
        diff,
        skills,
        config: {
          categories: prConfig.categories,
          strictness: prConfig.strictness,
          globalRules: globalConfig.customRules,
          repoRules: skills,
          perPrRules: prConfig.customRules,
          pathInclude: prConfig.pathInclude,
          pathExclude: prConfig.pathExclude,
        },
        existingOpenThreads: existingOpen.map((t) => ({
          path: t.file_path,
          line: t.line,
          summary: (t.first_body ?? "").slice(0, 200),
        })),
      };

      let result: ReviewResult | undefined;
      let attemptContext = ctx;
      for (let attempt = 1; attempt <= MAX_PROVIDER_OUTPUT_ATTEMPTS; attempt++) {
        try {
          result = await provider.review(attemptContext, onProgress, executionController.signal);
          break;
        } catch (error) {
          if (!(error instanceof ReviewOutputParseError)) throw error;
          recordSessions(refreshed.id, providerId, error.sessionIds, wt.cwd);
          if (attempt === MAX_PROVIDER_OUTPUT_ATTEMPTS) {
            throw new Error(
              `AI reviewer output was invalid after ${MAX_PROVIDER_OUTPUT_ATTEMPTS} attempts. ${error.message}${providerOutputExcerpt(error.rawOutput)}`,
            );
          }
          onProgress?.({
            type: "log",
            data: `[reviewer] ${error.message} Retrying the provider once.\n`,
          });
          attemptContext = { ...ctx, retryFeedback: error.message };
        }
      }
      if (!result) throw new Error("AI reviewer produced no validated result.");
      assertLease();
      recordSessions(refreshed.id, providerId, result.sessionIds, wt.cwd);

      // Dedupe + insert
      const existingFps = new Set(
        existingOpen.map((t) => fingerprint(t.file_path, t.line, t.first_body ?? "")),
      );
      let added = 0;
      let staleMarked = 0;

      const insertThread = db.prepare(`
      INSERT INTO threads (pr_id, file_path, line, side, severity, status, first_seen_sha, last_seen_sha, stale, created_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?, ?, 0, ?)
    `);
      const insertComment = db.prepare(`
      INSERT INTO comments (thread_id, author, body, head_sha, kind, created_at)
      VALUES (?, 'ai', ?, ?, 'normal', ?)
    `);

      const tx = db.transaction(() => {
        assertLease();
        // Staleness is review output too. Publish it in the terminal
        // transaction so a failed, cancelled, or fenced review changes no
        // user-visible thread state.
        const markStale = db.prepare(
          "UPDATE threads SET stale = 1 WHERE id = ? AND last_seen_sha != ?",
        );
        for (const thread of existingOpen) {
          staleMarked += markStale.run(thread.id, refreshed.head_sha).changes;
        }
        for (const c of result.comments) {
          const fp = fingerprint(c.path, c.line, c.body);
          if (existingFps.has(fp)) continue;
          const tid = Number(
            insertThread.run(
              refreshed.id,
              c.path,
              c.line,
              c.side,
              c.severity,
              refreshed.head_sha,
              refreshed.head_sha,
              now(),
            ).lastInsertRowid,
          );
          insertComment.run(tid, c.body, refreshed.head_sha, now());
          added++;
        }
        // Publish the terminal state in the same commit as its threads. A
        // waiter can therefore never observe "done" without all findings or
        // findings that belong to a still-running review.
        const published = reviewFinish.run(
          "done",
          result.summary,
          now(),
          null,
          added,
          staleMarked,
          reviewId,
          workerToken,
        );
        if (published.changes !== 1) {
          throw new Error(`Review ${reviewId} lost its worker lease before publication.`);
        }
      });
      tx();
      return { reviewId, addedThreads: added, staleMarked };
    } finally {
      cleanupWorktreeInBackground(wt);
    }
  } catch (e) {
    reviewFinish.run("error", null, now(), (e as Error).message, null, null, reviewId, workerToken);
    throw e;
  } finally {
    localReviewExecutions.delete(executionController);
    clearInterval(heartbeatTimer);
    clearTimeout(executionTimer);
  }
}

export type ThreadActionKind = "reply" | "revalidate";

export interface ThreadActionClaimArgs {
  threadId: number;
  prId: number;
  kind: ThreadActionKind;
  input: string;
  providerId: string;
  startedAt: string;
  workerToken: string;
  workerPid: number;
  beforeClaim?: () => void;
  beforeCreate?: () => void;
}

export function reconcileInterruptedThreadActions(db: Database.Database = getDb()): number {
  return reconcileInterruptedWork(
    db,
    "thread_actions",
    "Thread action interrupted before completion.",
  );
}

export function claimThreadAction(
  db: Database.Database,
  args: ThreadActionClaimArgs,
): { actionId: number; created: boolean; workerToken?: string } {
  return db
    .transaction(() => {
      args.beforeClaim?.();
      const active = db
        .prepare(
          `SELECT id, kind, input
           FROM thread_actions
           WHERE thread_id = ? AND status = 'running'
           ORDER BY id DESC LIMIT 1`,
        )
        .get(args.threadId) as Pick<ThreadActionRow, "id" | "kind" | "input"> | undefined;
      if (active) {
        if (active.kind === args.kind && active.input === args.input) {
          return { actionId: active.id, created: false };
        }
        throw new Error(
          `Thread ${args.threadId} already has active ${active.kind} action ${active.id}. Await it before starting ${args.kind}.`,
        );
      }

      args.beforeCreate?.();
      const actionId = Number(
        db
          .prepare(
            `INSERT INTO thread_actions
               (thread_id, pr_id, kind, input, provider, status, started_at, heartbeat_at, worker_token, worker_pid)
             VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
          )
          .run(
            args.threadId,
            args.prId,
            args.kind,
            args.input,
            args.providerId,
            args.startedAt,
            args.startedAt,
            args.workerToken,
            args.workerPid,
          ).lastInsertRowid,
      );
      return { actionId, created: true, workerToken: args.workerToken };
    })
    .immediate();
}

export function getThreadAction(actionId: number): ThreadActionRow | undefined {
  return getDb().prepare("SELECT * FROM thread_actions WHERE id = ?").get(actionId) as
    | ThreadActionRow
    | undefined;
}

export function getLatestThreadActionForThread(threadId: number): ThreadActionRow | undefined {
  return getDb()
    .prepare("SELECT * FROM thread_actions WHERE thread_id = ? ORDER BY id DESC LIMIT 1")
    .get(threadId) as ThreadActionRow | undefined;
}

export interface WaitForThreadActionOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  pollIntervalMs?: number;
  onProgress?: (action: ThreadActionRow) => void;
}

export async function waitForThreadAction(
  actionId: number,
  options: WaitForThreadActionOptions = {},
): Promise<ThreadActionRow> {
  return waitForDurableWork(actionId, options, {
    label: "Thread action",
    activeDescription: "the action",
    reconcile: reconcileInterruptedThreadActions,
    get: () => getThreadAction(actionId),
  });
}

export interface StartedThreadAction<T> {
  actionId: number;
  created: boolean;
  kind: ThreadActionKind;
  completion: Promise<T>;
}

interface PreparedThreadAction<T> {
  publish(): T;
}

function parseThreadActionResult<T>(action: ThreadActionRow): T {
  if (action.result === null) throw new Error(`Thread action ${action.id} has no result.`);
  return JSON.parse(action.result) as T;
}

function startThreadAction<T>(args: {
  threadId: number;
  prId: number;
  kind: ThreadActionKind;
  input: string;
  providerId: string;
  beforeCreate?: () => void;
  execute(signal: AbortSignal): Promise<PreparedThreadAction<T>>;
}): StartedThreadAction<T> {
  const db = getDb();
  const claim = claimThreadAction(db, {
    threadId: args.threadId,
    prId: args.prId,
    kind: args.kind,
    input: args.input,
    providerId: args.providerId,
    startedAt: now(),
    workerToken: randomUUID(),
    workerPid: process.pid,
    beforeClaim: () => reconcileInterruptedThreadActions(db),
    beforeCreate: args.beforeCreate,
  });

  if (!claim.created) {
    const waitController = new AbortController();
    localThreadActionWaiters.add(waitController);
    return {
      ...claim,
      kind: args.kind,
      completion: waitForThreadAction(claim.actionId, { signal: waitController.signal })
        .then(parseThreadActionResult<T>)
        .finally(() => localThreadActionWaiters.delete(waitController)),
    };
  }

  const executionController = new AbortController();
  localThreadActionExecutions.add(executionController);
  const lifecycleError = new Error(
    `Thread action exceeded the ${Math.round(THREAD_ACTION_EXECUTION_TIMEOUT_MS / 60_000)}-minute total lifecycle limit.`,
  );
  const executionTimer = setTimeout(
    () => executionController.abort(lifecycleError),
    THREAD_ACTION_EXECUTION_TIMEOUT_MS,
  );
  executionTimer.unref?.();
  const heartbeat = db.prepare(
    "UPDATE thread_actions SET heartbeat_at = ? WHERE id = ? AND worker_token = ? AND status = 'running'",
  );
  const heartbeatTimer = setInterval(() => {
    try {
      heartbeat.run(now(), claim.actionId, claim.workerToken);
    } catch {
      // See review heartbeat above: lease expiry is the safety mechanism.
    }
  }, DURABLE_HEARTBEAT_MS);
  const finish = db.prepare(
    `UPDATE thread_actions
     SET status = ?, result = ?, finished_at = ?, error = ?
     WHERE id = ? AND worker_token = ? AND status = 'running'`,
  );
  const assertLease = () => {
    const ownership = db
      .prepare(
        "SELECT 1 FROM thread_actions WHERE id = ? AND worker_token = ? AND status = 'running'",
      )
      .get(claim.actionId, claim.workerToken);
    if (!ownership) {
      throw new Error(`Thread action ${claim.actionId} lost its worker lease before publication.`);
    }
  };

  const completion = (async () => {
    try {
      const prepared = await args.execute(executionController.signal);
      let result!: T;
      db.transaction(() => {
        assertLease();
        result = prepared.publish();
        const published = finish.run(
          "done",
          JSON.stringify(result),
          now(),
          null,
          claim.actionId,
          claim.workerToken,
        );
        if (published.changes !== 1) {
          throw new Error(
            `Thread action ${claim.actionId} lost its worker lease before publication.`,
          );
        }
      }).immediate();
      return result;
    } catch (error) {
      finish.run(
        "error",
        null,
        now(),
        error instanceof Error ? error.message : String(error),
        claim.actionId,
        claim.workerToken,
      );
      throw error;
    } finally {
      localThreadActionExecutions.delete(executionController);
      clearInterval(heartbeatTimer);
      clearTimeout(executionTimer);
    }
  })();

  return { ...claim, kind: args.kind, completion };
}

export interface ReplyArgs {
  repo: RepoRow;
  pr: PrRow;
  threadId: number;
  userMessage: string;
  userMessageAlreadyPersisted?: boolean;
  providerId: string;
  onProgress?: ProviderProgress;
  signal?: AbortSignal;
}

async function prepareReply(
  args: ReplyArgs,
): Promise<PreparedThreadAction<{ aiCommentId: number }>> {
  const { repo, pr, threadId, userMessage, providerId, onProgress, signal } = args;
  const provider = getProvider(providerId);
  const db = getDb();

  const thread = db
    .prepare("SELECT * FROM threads WHERE id = ? AND pr_id = ?")
    .get(threadId, pr.id) as ThreadRow | undefined;
  if (!thread) throw new Error("thread not found");
  const history = db
    .prepare("SELECT * FROM comments WHERE thread_id = ? ORDER BY id ASC")
    .all(threadId) as CommentRow[];

  const refreshed = await hydratePR(repo, pr.number, signal);

  const wt = await preparePrHeadWorktree({ repo, pr: refreshed, onProgress, signal });
  try {
    const ctx: ReplyContext = {
      cwd: wt.cwd,
      prTitle: refreshed.title,
      prNumber: refreshed.number,
      repoSlug: `${repo.owner}/${repo.name}`,
      headSha: refreshed.head_sha,
      threadAnchor: { path: thread.file_path, line: thread.line },
      threadHistory: history.map((c) => ({ author: c.author as "ai" | "user", body: c.body })),
      userMessage,
      skills: getSkills(repo.id),
    };

    const result = await provider.reply(ctx, onProgress, signal);
    recordSessions(refreshed.id, providerId, result.sessionIds, wt.cwd);
    return {
      publish: () => {
        const aiCommentId = Number(
          db
            .prepare(
              `INSERT INTO comments (thread_id, author, body, head_sha, kind, created_at)
               VALUES (?, 'ai', ?, ?, 'normal', ?)`,
            )
            .run(threadId, result.body, refreshed.head_sha, now()).lastInsertRowid,
        );
        return { aiCommentId };
      },
    };
  } finally {
    cleanupWorktreeInBackground(wt);
  }
}

export interface RevalidateArgs {
  repo: RepoRow;
  pr: PrRow;
  threadId: number;
  providerId: string;
  onProgress?: ProviderProgress;
  signal?: AbortSignal;
}

async function prepareRevalidate(
  args: RevalidateArgs,
): Promise<PreparedThreadAction<{ resolved: boolean; commentId: number }>> {
  const { repo, pr, threadId, providerId, onProgress, signal } = args;
  const provider = getProvider(providerId);
  const db = getDb();

  const refreshed = await hydratePR(repo, pr.number, signal);

  const thread = db
    .prepare("SELECT * FROM threads WHERE id = ? AND pr_id = ?")
    .get(threadId, refreshed.id) as ThreadRow | undefined;
  if (!thread) throw new Error("thread not found");

  const history = db
    .prepare("SELECT * FROM comments WHERE thread_id = ? ORDER BY id ASC")
    .all(threadId) as CommentRow[];

  const wt = await preparePrHeadWorktree({ repo, pr: refreshed, onProgress, signal });
  try {
    const ctx: RevalidateContext = {
      cwd: wt.cwd,
      prTitle: refreshed.title,
      prNumber: refreshed.number,
      repoSlug: `${repo.owner}/${repo.name}`,
      headSha: refreshed.head_sha,
      baseSha: refreshed.base_sha,
      threadAnchor: { path: thread.file_path, line: thread.line },
      threadHistory: history.map((c) => ({ author: c.author as "ai" | "user", body: c.body })),
      skills: getSkills(repo.id),
    };

    const result = await provider.revalidate(ctx, onProgress, signal);
    recordSessions(refreshed.id, providerId, result.sessionIds, wt.cwd);
    return {
      publish: () => {
        // The thread mutation, comment, and durable action completion share
        // the caller's transaction, so waiters never observe partial output.
        db.prepare("UPDATE threads SET stale = 0, last_seen_sha = ? WHERE id = ?").run(
          refreshed.head_sha,
          threadId,
        );
        const commentId = Number(
          db
            .prepare(
              `INSERT INTO comments (thread_id, author, body, head_sha, kind, created_at)
               VALUES (?, 'ai', ?, ?, ?, ?)`,
            )
            .run(
              threadId,
              result.body,
              refreshed.head_sha,
              result.resolved ? "revalidate-resolved" : "revalidate-unresolved",
              now(),
            ).lastInsertRowid,
        );
        if (result.resolved) {
          db.prepare("UPDATE threads SET status = 'resolved' WHERE id = ?").run(threadId);
        }
        return { resolved: result.resolved, commentId };
      },
    };
  } finally {
    cleanupWorktreeInBackground(wt);
  }
}

export function startReply(args: ReplyArgs): StartedThreadAction<{ aiCommentId: number }> {
  const db = getDb();
  return startThreadAction({
    threadId: args.threadId,
    prId: args.pr.id,
    kind: "reply",
    input: args.userMessage,
    providerId: args.providerId,
    beforeCreate: args.userMessageAlreadyPersisted
      ? undefined
      : () => {
          // Persist the user's input in the same transaction that claims the
          // action. Provider failure must never make a submitted message vanish,
          // while joined callers must not duplicate it. This pre-hydration SHA is
          // intentionally best-effort; the AI response records the refreshed SHA.
          db.prepare(
            `INSERT INTO comments (thread_id, author, body, head_sha, kind, created_at)
             VALUES (?, 'user', ?, ?, 'normal', ?)`,
          ).run(args.threadId, args.userMessage, args.pr.head_sha, now());
        },
    execute: (signal) => prepareReply({ ...args, signal }),
  });
}

export function startRevalidate(
  args: RevalidateArgs,
): StartedThreadAction<{ resolved: boolean; commentId: number }> {
  return startThreadAction({
    threadId: args.threadId,
    prId: args.pr.id,
    kind: "revalidate",
    input: "",
    providerId: args.providerId,
    execute: (signal) => prepareRevalidate({ ...args, signal }),
  });
}

export function setThreadStatus(threadId: number, status: "open" | "resolved"): void {
  getDb().prepare("UPDATE threads SET status = ? WHERE id = ?").run(status, threadId);
}

export function getReview(reviewId: number): ReviewRow | undefined {
  return getDb().prepare("SELECT * FROM reviews WHERE id = ?").get(reviewId) as
    | ReviewRow
    | undefined;
}

export function getLatestReviewForPR(prId: number): ReviewRow | undefined {
  return getDb()
    .prepare("SELECT * FROM reviews WHERE pr_id = ? ORDER BY id DESC LIMIT 1")
    .get(prId) as ReviewRow | undefined;
}
