import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase, type WorkItemRow } from "./db.js";
import {
  getThreadActionContextVersion,
  operationSnapshot,
  threadActionIdempotencyKey,
  waitOperation,
} from "./operations.js";

const mocks = vi.hoisted(() => ({
  db: undefined as unknown as Database.Database,
}));

vi.mock("./db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db.js")>();
  return { ...actual, getDb: () => mocks.db };
});

beforeEach(() => {
  mocks.db = new Database(":memory:");
  migrateDatabase(mocks.db);
  mocks.db
    .prepare("INSERT INTO repos (id, owner, name, local_path) VALUES (1, 'test', 'repo', '/tmp')")
    .run();
  mocks.db
    .prepare(
      `INSERT INTO prs
       (id, repo_id, number, title, head_sha, base_sha, head_ref, base_ref,
        state, url, updated_at)
       VALUES (5, 1, 7, 'PR', 'head', 'base', 'feature', 'main', 'OPEN',
               'https://example.test/pr/7', ?)`,
    )
    .run(new Date().toISOString());
});

afterEach(() => mocks.db.close());

function insertWork(
  status: "running" | "done" | "error",
  relatedId: number | null = null,
  error: string | null = null,
): void {
  const timestamp = new Date().toISOString();
  mocks.db
    .prepare(
      `INSERT INTO work_items
       (id, kind, dedupe_key, payload, status, result, created_at, started_at,
        heartbeat_at, finished_at, worker_token, worker_pid, attempt_count,
        target_id, head_sha, base_sha, provider, config_fingerprint, phase, related_id, error)
       VALUES ('operation-1', 'review', 'review:5', ?, ?, ?, ?, ?, ?, ?,
               'token', 123, 1, 5, 'head', 'base', 'test', 'fingerprint', ?, ?, ?)`,
    )
    .run(
      JSON.stringify({ kind: "review", prId: 5 }),
      status,
      status === "done" ? JSON.stringify({ reviewId: relatedId }) : null,
      timestamp,
      timestamp,
      timestamp,
      status === "running" ? null : timestamp,
      status === "done" ? "completed" : status === "error" ? "failed" : "running_provider",
      relatedId,
      error,
    );
}

describe("durable operation snapshots", () => {
  it("returns a bounded healthy snapshot instead of throwing on wait expiry", async () => {
    insertWork("running");

    await expect(waitOperation("operation-1", 5)).resolves.toMatchObject({
      operationId: "operation-1",
      status: "running",
      terminal: false,
      phase: "running_provider",
      nextAction: { tool: "wait_operation" },
    });
  });

  it("returns a structured terminal snapshot when an operation fails", async () => {
    insertWork("error", null, "provider exploded");

    await expect(waitOperation("operation-1", 0)).resolves.toMatchObject({
      operationId: "operation-1",
      status: "failed",
      terminal: true,
      phase: "failed",
      error: "provider exploded",
      review: { gate: "failed" },
    });
  });

  it("uses immutable review output and computes the live exact-head gate", () => {
    mocks.db
      .prepare(
        `INSERT INTO reviews
         (id, pr_id, head_sha, provider, status, summary, result, started_at,
          heartbeat_at, finished_at, added_threads, stale_marked)
         VALUES (11, 5, 'head', 'test', 'done', 'Clean review', ?, ?, ?, ?, 0, 0)`,
      )
      .run(
        JSON.stringify({ summary: "Clean review", comments: [] }),
        new Date().toISOString(),
        new Date().toISOString(),
        new Date().toISOString(),
      );
    insertWork("done", 11);
    const row = mocks.db
      .prepare("SELECT * FROM work_items WHERE id = 'operation-1'")
      .get() as WorkItemRow;

    expect(operationSnapshot(row)).toMatchObject({
      status: "completed",
      terminal: true,
      review: {
        reviewId: 11,
        reviewedHeadSha: "head",
        currentHeadSha: "head",
        gate: "clean",
        findings: [],
      },
    });

    mocks.db.prepare("UPDATE prs SET head_sha = 'new-head' WHERE id = 5").run();
    expect(operationSnapshot(row).review?.gate).toBe("stale");
  });

  it("versions thread actions by provider and live conversation context", () => {
    mocks.db
      .prepare(
        `INSERT INTO threads
         (id, pr_id, status, first_seen_sha, last_seen_sha, created_at)
         VALUES (12, 5, 'open', 'head', 'head', 'now')`,
      )
      .run();
    const initialContext = getThreadActionContextVersion(12);
    const initial = threadActionIdempotencyKey("revalidate", 12, {
      headSha: "head",
      providerId: "claude",
      contextVersion: initialContext,
    });
    mocks.db
      .prepare(
        `INSERT INTO comments (thread_id, author, body, head_sha, kind, created_at)
         VALUES (12, 'user', 'more context', 'head', 'normal', 'now')`,
      )
      .run();
    const afterComment = threadActionIdempotencyKey("revalidate", 12, {
      headSha: "head",
      providerId: "claude",
      contextVersion: getThreadActionContextVersion(12),
    });
    const otherProvider = threadActionIdempotencyKey("revalidate", 12, {
      headSha: "head",
      providerId: "codex",
      contextVersion: getThreadActionContextVersion(12),
    });

    expect(afterComment).not.toBe(initial);
    expect(otherProvider).not.toBe(afterComment);
  });
});
