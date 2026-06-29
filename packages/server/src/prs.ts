import { getDb, type PrRow, type RepoRow, type ThreadRow, type CommentRow } from "./db.js";
import * as gh from "./github.js";
import { purgeSessionsForPrs } from "./sessions.js";

export interface PrListItem {
  id: number;
  number: number;
  title: string;
  state: string;
  headRef: string;
  baseRef: string;
  url: string;
  author: string | null;
  updatedAt: string;
  hasReview: boolean;
  openThreads: number;
}

export async function refreshOpenPRs(repo: RepoRow): Promise<PrListItem[]> {
  const open = await gh.listOpenPRs(repo.owner, repo.name);
  const openNumbers = new Set(open.map((p) => p.number));
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO prs (repo_id, number, title, body, head_sha, base_sha, head_ref, base_ref, state, url, author, updated_at)
    VALUES (?, ?, ?, '', '', '', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(repo_id, number) DO UPDATE SET
      title = excluded.title,
      head_ref = excluded.head_ref,
      base_ref = excluded.base_ref,
      state = excluded.state,
      url = excluded.url,
      author = excluded.author,
      updated_at = excluded.updated_at
  `);
  const tx = db.transaction(() => {
    for (const p of open) {
      upsert.run(
        repo.id,
        p.number,
        p.title,
        p.headRefName,
        p.baseRefName,
        p.state,
        p.url,
        p.author?.login ?? null,
        p.updatedAt,
      );
    }
  });
  tx();

  const staleNumbers = (
    db.prepare("SELECT number FROM prs WHERE repo_id = ?").all(repo.id) as { number: number }[]
  )
    .map((p) => p.number)
    .filter((number) => !openNumbers.has(number));
  await cleanupClosedPRs(repo, staleNumbers);

  return listPRsForRepo(repo.id);
}

export function listPRsForRepo(repoId: number): PrListItem[] {
  const db = getDb();
  const rows = db
    .prepare(
      `
    SELECT
      p.id, p.number, p.title, p.state, p.head_ref AS headRef, p.base_ref AS baseRef,
      p.url, p.author, p.updated_at AS updatedAt,
      EXISTS(SELECT 1 FROM reviews r WHERE r.pr_id = p.id) AS hasReview,
      (SELECT COUNT(*) FROM threads t WHERE t.pr_id = p.id AND t.status = 'open') AS openThreads
    FROM prs p
    WHERE p.repo_id = ?
    ORDER BY p.number DESC
  `,
    )
    .all(repoId) as (Omit<PrListItem, "hasReview"> & { hasReview: 0 | 1 })[];
  return rows.map((r) => ({ ...r, hasReview: !!r.hasReview }));
}

export function getPRById(prId: number): PrRow | undefined {
  return getDb().prepare("SELECT * FROM prs WHERE id = ?").get(prId) as PrRow | undefined;
}

export async function hydratePR(repo: RepoRow, prNumber: number): Promise<PrRow> {
  const detail = await gh.getPR(repo.owner, repo.name, prNumber);
  const db = getDb();
  db.prepare(
    `
    INSERT INTO prs (repo_id, number, title, body, head_sha, base_sha, head_ref, base_ref, state, url, author, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(repo_id, number) DO UPDATE SET
      title = excluded.title,
      body = excluded.body,
      head_sha = excluded.head_sha,
      base_sha = excluded.base_sha,
      head_ref = excluded.head_ref,
      base_ref = excluded.base_ref,
      state = excluded.state,
      url = excluded.url,
      author = excluded.author,
      updated_at = excluded.updated_at
  `,
  ).run(
    repo.id,
    detail.number,
    detail.title,
    detail.body,
    detail.headRefOid,
    detail.baseRefOid,
    detail.headRefName,
    detail.baseRefName,
    detail.state,
    detail.url,
    detail.author?.login ?? null,
    detail.updatedAt,
  );
  return db
    .prepare("SELECT * FROM prs WHERE repo_id = ? AND number = ?")
    .get(repo.id, prNumber) as PrRow;
}

export function listThreadsForPR(prId: number): (ThreadRow & { comments: CommentRow[] })[] {
  const db = getDb();
  const threads = db
    .prepare("SELECT * FROM threads WHERE pr_id = ? ORDER BY id ASC")
    .all(prId) as ThreadRow[];
  const getComments = db.prepare("SELECT * FROM comments WHERE thread_id = ? ORDER BY id ASC");
  return threads.map((t) => ({ ...t, comments: getComments.all(t.id) as CommentRow[] }));
}

export async function cleanupClosedPRs(repo: RepoRow, closedNumbers: number[]): Promise<number> {
  if (closedNumbers.length === 0) return 0;
  const db = getDb();
  const placeholders = closedNumbers.map(() => "?").join(",");
  // Delete the AI chat sessions tied to these PRs before the rows (and their
  // cascading ai_sessions rows) are gone, so review sessions don't linger in
  // the user's provider CLI history.
  const prIds = (
    db
      .prepare(`SELECT id FROM prs WHERE repo_id = ? AND number IN (${placeholders})`)
      .all(repo.id, ...closedNumbers) as { id: number }[]
  ).map((r) => r.id);
  await purgeSessionsForPrs(prIds);
  const result = db
    .prepare(`DELETE FROM prs WHERE repo_id = ? AND number IN (${placeholders})`)
    .run(repo.id, ...closedNumbers);
  return result.changes;
}

export async function purgeClosedForRepo(repo: RepoRow): Promise<number> {
  const closed = await gh.listClosedPRs(repo.owner, repo.name);
  if (closed.length === 0) return 0;
  return cleanupClosedPRs(
    repo,
    closed.map((p) => p.number),
  );
}

/** Wipe reviews, threads, and comments for a PR. PR row is retained so the
 *  user can immediately run a fresh review. Also deletes the AI chat sessions
 *  from that review so a re-run doesn't accumulate stale sessions. */
export async function clearReviewData(prId: number): Promise<{
  threads: number;
  comments: number;
  reviews: number;
}> {
  await purgeSessionsForPrs([prId]);
  const db = getDb();
  const tx = db.transaction(() => {
    const comments = db
      .prepare("DELETE FROM comments WHERE thread_id IN (SELECT id FROM threads WHERE pr_id = ?)")
      .run(prId).changes;
    const threads = db.prepare("DELETE FROM threads WHERE pr_id = ?").run(prId).changes;
    const reviews = db.prepare("DELETE FROM reviews WHERE pr_id = ?").run(prId).changes;
    return { threads, comments, reviews };
  });
  return tx();
}
