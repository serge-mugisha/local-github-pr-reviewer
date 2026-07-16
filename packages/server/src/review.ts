import {
  getDb,
  type PrRow,
  type RepoRow,
  type ThreadRow,
  type CommentRow,
  type ReviewRow,
} from "./db.js";
import { getProvider } from "./providers/index.js";
import type {
  ProviderProgress,
  ReviewContext,
  ReplyContext,
  RevalidateContext,
} from "./providers/types.js";
import { getSkills } from "./skills.js";
import { getPrReviewConfig, getGlobalReviewConfig } from "./reviewConfig.js";
import * as gh from "./github.js";
import { hydratePR } from "./prs.js";
import { recordSessions } from "./sessions.js";
import { preparePrHeadWorktree } from "./prWorktree.js";

function now(): string {
  return new Date().toISOString();
}

const REVIEW_HEARTBEAT_MS = 5_000;
const REVIEW_STALE_AFTER_MS = 30_000;

export function reconcileInterruptedReviews(): number {
  const finishedAt = now();
  const staleBefore = new Date(Date.now() - REVIEW_STALE_AFTER_MS).toISOString();
  return getDb()
    .prepare(
      `
      UPDATE reviews
      SET status = 'error', finished_at = ?, error = 'Review interrupted before completion.'
      WHERE status = 'running'
        AND (heartbeat_at IS NULL OR heartbeat_at < ?)
    `,
    )
    .run(finishedAt, staleBefore).changes;
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
}

export async function runReview(
  args: RunReviewArgs,
): Promise<{ reviewId: number; addedThreads: number; staleMarked: number }> {
  const { repo, pr, providerId, onProgress } = args;
  const provider = getProvider(providerId);
  const db = getDb();

  const reviewInsert = db.prepare(`
    INSERT INTO reviews (pr_id, head_sha, provider, status, started_at, heartbeat_at)
    VALUES (?, ?, ?, 'running', ?, ?)
  `);
  const startedAt = now();
  const reviewId = Number(
    reviewInsert.run(pr.id, pr.head_sha, providerId, startedAt, startedAt).lastInsertRowid,
  );
  const heartbeat = db.prepare(
    "UPDATE reviews SET heartbeat_at = ? WHERE id = ? AND status = 'running'",
  );
  const heartbeatTimer = setInterval(() => heartbeat.run(now(), reviewId), REVIEW_HEARTBEAT_MS);

  const reviewFinish = db.prepare(`
    UPDATE reviews SET status = ?, summary = ?, finished_at = ?, error = ? WHERE id = ?
  `);

  try {
    const refreshed = await hydratePR(repo, pr.number);
    db.prepare("UPDATE reviews SET head_sha = ? WHERE id = ?").run(refreshed.head_sha, reviewId);
    const diff = await gh.getPRDiff(repo.owner, repo.name, pr.number);

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

    // Mark threads on a different head_sha as stale (not resolved — user-only resolves)
    let staleMarked = 0;
    if (existingOpen.length > 0) {
      const stmt = db.prepare("UPDATE threads SET stale = 1 WHERE id = ? AND last_seen_sha != ?");
      for (const t of existingOpen) {
        const r = stmt.run(t.id, refreshed.head_sha);
        staleMarked += r.changes;
      }
    }

    const wt = await preparePrHeadWorktree({ repo, pr: refreshed, onProgress });
    try {
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

      const result = await provider.review(ctx, onProgress);
      recordSessions(refreshed.id, providerId, result.sessionIds, wt.cwd);

      // Dedupe + insert
      const existingFps = new Set(
        existingOpen.map((t) => fingerprint(t.file_path, t.line, t.first_body ?? "")),
      );
      let added = 0;

      const insertThread = db.prepare(`
      INSERT INTO threads (pr_id, file_path, line, side, severity, status, first_seen_sha, last_seen_sha, stale, created_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?, ?, 0, ?)
    `);
      const insertComment = db.prepare(`
      INSERT INTO comments (thread_id, author, body, head_sha, kind, created_at)
      VALUES (?, 'ai', ?, ?, 'normal', ?)
    `);

      const tx = db.transaction(() => {
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
      });
      tx();

      reviewFinish.run("done", result.summary, now(), null, reviewId);
      return { reviewId, addedThreads: added, staleMarked };
    } finally {
      await wt.cleanup();
    }
  } catch (e) {
    reviewFinish.run("error", null, now(), (e as Error).message, reviewId);
    throw e;
  } finally {
    clearInterval(heartbeatTimer);
  }
}

export interface ReplyArgs {
  repo: RepoRow;
  pr: PrRow;
  threadId: number;
  userMessage: string;
  providerId: string;
  onProgress?: ProviderProgress;
}

export async function runReply(args: ReplyArgs): Promise<{ aiCommentId: number }> {
  const { repo, pr, threadId, userMessage, providerId, onProgress } = args;
  const provider = getProvider(providerId);
  const db = getDb();

  const thread = db
    .prepare("SELECT * FROM threads WHERE id = ? AND pr_id = ?")
    .get(threadId, pr.id) as ThreadRow | undefined;
  if (!thread) throw new Error("thread not found");
  const history = db
    .prepare("SELECT * FROM comments WHERE thread_id = ? ORDER BY id ASC")
    .all(threadId) as CommentRow[];

  const refreshed = await hydratePR(repo, pr.number);

  // Append the user's new message first.
  db.prepare(
    `
    INSERT INTO comments (thread_id, author, body, head_sha, kind, created_at)
    VALUES (?, 'user', ?, ?, 'normal', ?)
  `,
  ).run(threadId, userMessage, refreshed.head_sha, now());

  const wt = await preparePrHeadWorktree({ repo, pr: refreshed, onProgress });
  try {
    const ctx: ReplyContext = {
      cwd: wt.cwd,
      prTitle: refreshed.title,
      prNumber: refreshed.number,
      repoSlug: `${repo.owner}/${repo.name}`,
      headSha: refreshed.head_sha,
      threadAnchor: { path: thread.file_path, line: thread.line },
      threadHistory: [
        ...history.map((c) => ({ author: c.author as "ai" | "user", body: c.body })),
        { author: "user" as const, body: userMessage },
      ],
      userMessage,
      skills: getSkills(repo.id),
    };

    const result = await provider.reply(ctx, onProgress);
    recordSessions(refreshed.id, providerId, result.sessionIds, wt.cwd);

    const aiCommentId = Number(
      db
        .prepare(
          `
    INSERT INTO comments (thread_id, author, body, head_sha, kind, created_at)
    VALUES (?, 'ai', ?, ?, 'normal', ?)
  `,
        )
        .run(threadId, result.body, refreshed.head_sha, now()).lastInsertRowid,
    );

    return { aiCommentId };
  } finally {
    await wt.cleanup();
  }
}

export interface RevalidateArgs {
  repo: RepoRow;
  pr: PrRow;
  threadId: number;
  providerId: string;
  onProgress?: ProviderProgress;
}

export async function runRevalidate(
  args: RevalidateArgs,
): Promise<{ resolved: boolean; commentId: number }> {
  const { repo, pr, threadId, providerId, onProgress } = args;
  const provider = getProvider(providerId);
  const db = getDb();

  const refreshed = await hydratePR(repo, pr.number);

  const thread = db
    .prepare("SELECT * FROM threads WHERE id = ? AND pr_id = ?")
    .get(threadId, refreshed.id) as ThreadRow | undefined;
  if (!thread) throw new Error("thread not found");

  const history = db
    .prepare("SELECT * FROM comments WHERE thread_id = ? ORDER BY id ASC")
    .all(threadId) as CommentRow[];

  const wt = await preparePrHeadWorktree({ repo, pr: refreshed, onProgress });
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

    const result = await provider.revalidate(ctx, onProgress);
    recordSessions(refreshed.id, providerId, result.sessionIds, wt.cwd);

    // Mark thread fresh on this sha (no longer stale) regardless of result.
    db.prepare("UPDATE threads SET stale = 0, last_seen_sha = ? WHERE id = ?").run(
      refreshed.head_sha,
      threadId,
    );

    const commentId = Number(
      db
        .prepare(
          `
    INSERT INTO comments (thread_id, author, body, head_sha, kind, created_at)
    VALUES (?, 'ai', ?, ?, ?, ?)
  `,
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
  } finally {
    await wt.cleanup();
  }
}

export function setThreadStatus(threadId: number, status: "open" | "resolved"): void {
  getDb().prepare("UPDATE threads SET status = ? WHERE id = ?").run(status, threadId);
}

export function getReview(reviewId: number): ReviewRow | undefined {
  return getDb().prepare("SELECT * FROM reviews WHERE id = ?").get(reviewId) as
    | ReviewRow
    | undefined;
}
