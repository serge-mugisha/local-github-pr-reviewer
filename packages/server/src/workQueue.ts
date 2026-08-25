import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { getDb, type WorkItemRow } from "./db.js";

const configuredHeartbeatMs = Number(process.env.REVIEWER_HEARTBEAT_MS);
const HEARTBEAT_MS =
  Number.isFinite(configuredHeartbeatMs) && configuredHeartbeatMs >= 25
    ? configuredHeartbeatMs
    : 5_000;
const configuredStaleAfterMs = Number(process.env.REVIEWER_STALE_AFTER_MS);
const STALE_AFTER_MS =
  Number.isFinite(configuredStaleAfterMs) && configuredStaleAfterMs >= 250
    ? configuredStaleAfterMs
    : 30_000;
const MAX_ATTEMPTS = 3;
const MAX_LAUNCH_ATTEMPTS = 3;
const LAUNCH_RETRY_AFTER_MS = 5_000;
const POLL_INTERVAL_MS = 250;
const FINISHED_EVENT_RETENTION_MS = 24 * 60 * 60 * 1_000;

export type WorkPayload =
  | { kind: "review"; prId: number }
  | { kind: "reply"; threadId: number; message: string }
  | { kind: "revalidate"; threadId: number };

export interface EnqueuedWork {
  workId: string;
  created: boolean;
}

export interface WorkEvent {
  type: "log" | "stdout" | "stderr";
  data: string;
}

export interface WorkEventRow {
  id: number;
  work_id: string;
  event: string;
  created_at: string;
}

function now(): string {
  return new Date().toISOString();
}

function dedupeKey(payload: WorkPayload): string {
  if (payload.kind === "review") return `review:${payload.prId}`;
  return `thread:${payload.threadId}`;
}

export function getWorkItem(workId: string): WorkItemRow | undefined {
  return getDb().prepare("SELECT * FROM work_items WHERE id = ?").get(workId) as
    | WorkItemRow
    | undefined;
}

export function listWorkItems(): WorkItemRow[] {
  return getDb()
    .prepare("SELECT * FROM work_items ORDER BY created_at DESC")
    .all() as WorkItemRow[];
}

export function reconcileInterruptedWorkItems(): number {
  const db = getDb();
  const staleBefore = new Date(Date.now() - STALE_AFTER_MS).toISOString();
  const candidates = db
    .prepare(
      `SELECT * FROM work_items
       WHERE status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)`,
    )
    .all(staleBefore) as WorkItemRow[];
  let changed = 0;
  for (const work of candidates) {
    if (work.attempt_count < MAX_ATTEMPTS) {
      changed += getDb()
        .prepare(
          `UPDATE work_items
           SET status = 'queued', started_at = NULL, heartbeat_at = NULL,
               worker_token = NULL, worker_pid = NULL,
               launch_count = 0, last_launch_at = NULL,
               error = 'Worker disappeared; retrying safely.'
           WHERE id = ? AND status = 'running' AND worker_token = ?`,
        )
        .run(work.id, work.worker_token).changes;
    } else {
      changed += getDb()
        .prepare(
          `UPDATE work_items
           SET status = 'error', finished_at = ?,
               error = 'Reviewer worker repeatedly disappeared before completion.'
           WHERE id = ? AND status = 'running' AND worker_token = ?`,
        )
        .run(now(), work.id, work.worker_token).changes;
    }
  }
  return changed;
}

export function pruneFinishedWorkEvents(retentionMs = FINISHED_EVENT_RETENTION_MS): number {
  const cutoff = new Date(Date.now() - retentionMs).toISOString();
  return getDb()
    .prepare(
      `DELETE FROM work_events
       WHERE work_id IN (
         SELECT id FROM work_items
         WHERE status IN ('done', 'error', 'cancelled') AND finished_at < ?
       )`,
    )
    .run(cutoff).changes;
}

export function enqueueWork(
  payload: WorkPayload,
  options: { beforeCreate?: () => void } = {},
): EnqueuedWork {
  const db = getDb();
  const key = dedupeKey(payload);
  const result = db
    .transaction(() => {
      pruneFinishedWorkEvents();
      reconcileInterruptedWorkItems();
      const active = db
        .prepare(
          `SELECT id, payload FROM work_items
           WHERE dedupe_key = ? AND status IN ('queued', 'running')
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(key) as { id: string; payload: string } | undefined;
      if (active) {
        if (active.payload === JSON.stringify(payload)) {
          return { workId: active.id, created: false };
        }
        throw new Error(
          `Thread ${"threadId" in payload ? payload.threadId : "unknown"} already has another active Reviewer action. Wait for its task result before starting a new one.`,
        );
      }
      options.beforeCreate?.();
      const workId = randomUUID();
      db.prepare(
        `INSERT INTO work_items (id, kind, dedupe_key, payload, status, created_at)
         VALUES (?, ?, ?, ?, 'queued', ?)`,
      ).run(workId, payload.kind, key, JSON.stringify(payload), now());
      return { workId, created: true };
    })
    .immediate();
  ensureWorkItemRunning(result.workId);
  return result;
}

export function enqueueReplyWork(threadId: number, message: string, headSha: string): EnqueuedWork {
  return enqueueWork(
    { kind: "reply", threadId, message },
    {
      beforeCreate: () => {
        getDb()
          .prepare(
            `INSERT INTO comments (thread_id, author, body, head_sha, kind, created_at)
             VALUES (?, 'user', ?, ?, 'normal', ?)`,
          )
          .run(threadId, message, headSha, now());
      },
    },
  );
}

const compiledWorkerEntrypoint = fileURLToPath(new URL("./worker.js", import.meta.url));
const sourceWorkerEntrypoint = fileURLToPath(new URL("./worker.ts", import.meta.url));
const requireFromHere = createRequire(import.meta.url);

export function resolveWorkerLaunch(
  workId: string,
  fileExists: (path: string) => boolean = existsSync,
): { command: string; args: string[] } {
  if (fileExists(compiledWorkerEntrypoint)) {
    return { command: process.execPath, args: [compiledWorkerEntrypoint, workId] };
  }
  if (fileExists(sourceWorkerEntrypoint)) {
    let tsxCli: string;
    try {
      tsxCli = requireFromHere.resolve("tsx/cli");
    } catch {
      throw new Error(
        "Reviewer source worker requires installed dependencies. Run npm install, or npm run build before starting Reviewer.",
      );
    }
    return {
      command: process.execPath,
      args: [tsxCli, sourceWorkerEntrypoint, workId],
    };
  }
  throw new Error(
    "Reviewer worker entrypoint is missing. Run npm run build before starting Reviewer.",
  );
}

export function ensureWorkItemRunning(workId: string): WorkItemRow {
  reconcileInterruptedWorkItems();
  let work = getWorkItem(workId);
  if (!work) throw new Error(`Reviewer work item ${workId} not found.`);
  if (work.status === "queued") {
    const lastLaunch = work.last_launch_at ? Date.parse(work.last_launch_at) : 0;
    if (Date.now() - lastLaunch < LAUNCH_RETRY_AFTER_MS) return work;
    if (work.launch_count >= MAX_LAUNCH_ATTEMPTS) {
      getDb()
        .prepare(
          `UPDATE work_items SET status = 'error', finished_at = ?,
             error = 'Reviewer worker could not be launched after repeated launch failures.'
           WHERE id = ? AND status = 'queued'`,
        )
        .run(now(), workId);
      return getWorkItem(workId)!;
    }
    const launchAt = now();
    const reserved = getDb()
      .prepare(
        `UPDATE work_items
         SET launch_count = launch_count + 1, last_launch_at = ?
         WHERE id = ? AND status = 'queued'
           AND (last_launch_at IS NULL OR last_launch_at < ?)`,
      )
      .run(launchAt, workId, new Date(Date.now() - LAUNCH_RETRY_AFTER_MS).toISOString());
    if (reserved.changes !== 1) return getWorkItem(workId)!;
    let launch: ReturnType<typeof resolveWorkerLaunch>;
    try {
      launch = resolveWorkerLaunch(workId);
    } catch (error) {
      getDb()
        .prepare("UPDATE work_items SET status = 'error', error = ?, finished_at = ? WHERE id = ?")
        .run(error instanceof Error ? error.message : String(error), now(), workId);
      return getWorkItem(workId)!;
    }
    const child = spawn(launch.command, launch.args, {
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    child.once("error", (error) => {
      getDb()
        .prepare("UPDATE work_items SET error = ? WHERE id = ? AND status = 'queued'")
        .run(`Reviewer worker launch failed: ${error.message}`, workId);
    });
    child.once("exit", (code, signal) => {
      const current = getWorkItem(workId);
      if (current?.status !== "queued") return;
      getDb()
        .prepare("UPDATE work_items SET error = ? WHERE id = ? AND status = 'queued'")
        .run(
          `Reviewer worker exited before claiming work (code ${code ?? "none"}, signal ${signal ?? "none"}).`,
          workId,
        );
    });
    child.unref();
    work = getWorkItem(workId)!;
  }
  return work;
}

export function appendWorkEvent(workId: string, event: WorkEvent): void {
  try {
    getDb()
      .prepare("INSERT INTO work_events (work_id, event, created_at) VALUES (?, ?, ?)")
      .run(workId, JSON.stringify(event), now());
  } catch {
    // Progress is diagnostic, never authoritative. A transient DB lock may
    // drop a line, but must not interrupt the review that produces the result.
  }
}

export function listWorkEvents(workId: string, afterId = 0): WorkEventRow[] {
  return getDb()
    .prepare("SELECT * FROM work_events WHERE work_id = ? AND id > ? ORDER BY id")
    .all(workId, afterId) as WorkEventRow[];
}

export interface ClaimedWork {
  row: WorkItemRow;
  workerToken: string;
}

export function claimWorkItem(workId: string): ClaimedWork | undefined {
  const db = getDb();
  const workerToken = randomUUID();
  const timestamp = now();
  const claimed = db
    .prepare(
      `UPDATE work_items
       SET status = 'running', started_at = ?, heartbeat_at = ?,
           worker_token = ?, worker_pid = ?, attempt_count = attempt_count + 1,
           error = NULL
       WHERE id = ? AND status = 'queued'`,
    )
    .run(timestamp, timestamp, workerToken, process.pid, workId);
  if (claimed.changes !== 1) return undefined;
  return { row: getWorkItem(workId)!, workerToken };
}

export function startWorkHeartbeat(workId: string, workerToken: string): () => void {
  const statement = getDb().prepare(
    "UPDATE work_items SET heartbeat_at = ? WHERE id = ? AND worker_token = ? AND status = 'running'",
  );
  const timer = setInterval(() => {
    try {
      statement.run(now(), workId, workerToken);
    } catch {
      // A transient SQLite lock must not kill the detached worker. If writes
      // remain unavailable past the lease window, another process fences this
      // token and the final publication below is rejected safely.
    }
  }, HEARTBEAT_MS);
  return () => clearInterval(timer);
}

export function completeWorkItem(workId: string, workerToken: string, result: unknown): void {
  const updated = getDb()
    .prepare(
      `UPDATE work_items
       SET status = 'done', result = ?, error = NULL, finished_at = ?, heartbeat_at = ?
       WHERE id = ? AND worker_token = ? AND status = 'running'`,
    )
    .run(JSON.stringify(result), now(), now(), workId, workerToken);
  if (updated.changes !== 1) throw new Error(`Work item ${workId} lost its worker lease.`);
}

export function failWorkItem(workId: string, workerToken: string, error: unknown): void {
  getDb()
    .prepare(
      `UPDATE work_items
       SET status = 'error', error = ?, finished_at = ?, heartbeat_at = ?
       WHERE id = ? AND worker_token = ? AND status = 'running'`,
    )
    .run(error instanceof Error ? error.message : String(error), now(), now(), workId, workerToken);
}

export async function waitForWorkItem(
  workId: string,
  options: {
    signal?: AbortSignal;
    /** Null waits until completion or caller cancellation. */
    timeoutMs?: number | null;
    onEvent?: (event: WorkEvent) => void;
    onProgress?: (work: WorkItemRow) => void;
  } = {},
): Promise<WorkItemRow> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs === undefined ? 21 * 60 * 1_000 : options.timeoutMs;
  let eventCursor = 0;
  for (;;) {
    const work = ensureWorkItemRunning(workId);
    options.onProgress?.(work);
    for (const row of listWorkEvents(workId, eventCursor)) {
      eventCursor = row.id;
      options.onEvent?.(JSON.parse(row.event) as WorkEvent);
    }
    if (work.status === "done") return work;
    if (work.status === "error" || work.status === "cancelled") {
      throw new Error(work.error ?? `Reviewer work item ${workId} failed.`);
    }
    if (timeoutMs !== null && Date.now() - started >= timeoutMs) {
      throw new Error(`Timed out waiting for Reviewer work item ${workId}.`);
    }
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        options.signal?.removeEventListener("abort", abort);
        resolve();
      };
      const timer = setTimeout(finish, POLL_INTERVAL_MS);
      const abort = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        reject(options.signal?.reason ?? new Error("Reviewer wait cancelled."));
      };
      options.signal?.addEventListener("abort", abort, { once: true });
    });
  }
}
