import { getDb, type AiSessionRow } from "./db.js";
import { getProvider } from "./providers/index.js";

/**
 * Tracks the AI CLI chat sessions spawned while reviewing a PR so they can be
 * deleted when the PR (or its review data) is cleaned up. Without this, every
 * review/reply/revalidate leaves a session behind in the user's
 * `~/.claude`/`~/.gemini` history, polluting their real coding sessions.
 */

const now = (): string => new Date().toISOString();

/** Associate the chat sessions a provider just created with a PR. */
export function recordSessions(
  prId: number,
  provider: string,
  sessionIds: string[] | undefined,
  cwd: string,
): void {
  const ids = (sessionIds ?? []).filter(Boolean);
  if (ids.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO ai_sessions (pr_id, provider, session_id, cwd, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(pr_id, provider, session_id) DO NOTHING
  `);
  const at = now();
  const tx = db.transaction(() => {
    for (const id of ids) stmt.run(prId, provider, id, cwd, at);
  });
  tx();
}

/** Hand the recorded sessions to their providers for on-disk deletion. */
async function deleteSessionFiles(rows: AiSessionRow[]): Promise<number> {
  const byProvider = new Map<string, { cwd: string; ids: string[] }>();
  for (const r of rows) {
    const group = byProvider.get(r.provider) ?? { cwd: r.cwd, ids: [] };
    group.ids.push(r.session_id);
    byProvider.set(r.provider, group);
  }
  let removed = 0;
  for (const [providerId, { cwd, ids }] of byProvider) {
    let provider;
    try {
      provider = getProvider(providerId);
    } catch {
      continue; // provider no longer registered
    }
    if (!provider.deleteSessions) continue;
    try {
      removed += await provider.deleteSessions(ids, cwd);
    } catch {
      /* best-effort cleanup; never block PR purge on it */
    }
  }
  return removed;
}

/**
 * Delete the on-disk chat sessions for the given PRs and forget the rows.
 * Safe to call before the PR rows themselves are deleted (the ai_sessions
 * rows would otherwise vanish via cascade before we could read them).
 */
export async function purgeSessionsForPrs(prIds: number[]): Promise<number> {
  if (prIds.length === 0) return 0;
  const db = getDb();
  const placeholders = prIds.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT * FROM ai_sessions WHERE pr_id IN (${placeholders})`)
    .all(...prIds) as AiSessionRow[];
  if (rows.length === 0) return 0;
  const removed = await deleteSessionFiles(rows);
  db.prepare(`DELETE FROM ai_sessions WHERE pr_id IN (${placeholders})`).run(...prIds);
  return removed;
}
