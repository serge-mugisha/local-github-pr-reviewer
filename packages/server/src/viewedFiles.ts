import { getDb, type ViewedFileRow } from "./db.js";

function now(): string {
  return new Date().toISOString();
}

/** Files marked as "viewed" for a PR at the given head sha. Anything stored
 *  against a different head sha is treated as unviewed — matches GitHub's
 *  behavior of resetting viewed state when new commits are pushed. */
export function listViewedFiles(prId: number, headSha: string): string[] {
  const rows = getDb()
    .prepare("SELECT file_path FROM viewed_files WHERE pr_id = ? AND head_sha = ?")
    .all(prId, headSha) as Pick<ViewedFileRow, "file_path">[];
  return rows.map((r) => r.file_path);
}

export function setFileViewed(
  prId: number,
  filePath: string,
  headSha: string,
  viewed: boolean,
): void {
  const db = getDb();
  if (!viewed) {
    db.prepare("DELETE FROM viewed_files WHERE pr_id = ? AND file_path = ?").run(prId, filePath);
    return;
  }
  db.prepare(
    `
    INSERT INTO viewed_files (pr_id, file_path, head_sha, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(pr_id, file_path) DO UPDATE SET
      head_sha = excluded.head_sha,
      updated_at = excluded.updated_at
  `,
  ).run(prId, filePath, headSha, now());
}
