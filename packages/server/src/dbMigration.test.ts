import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { Worker } from "node:worker_threads";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDatabase } from "./db.js";
import { OPEN_PR_UPSERT_SQL } from "./prs.js";

let db: Database.Database | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

describe("PR schema migration", () => {
  it("serializes simultaneous migrations from separate processes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reviewer-migration-"));
    const dbPath = join(dir, "reviewer.db");
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const migrationSource = migrateDatabase.toString();
    const workerSource = `
      const { parentPort, workerData } = require("node:worker_threads");
      const Database = require("better-sqlite3");
      (async () => {
        const migrateDatabase = eval("(" + workerData.migrationSource + ")");
        const database = new Database(workerData.dbPath);
        const barrier = new Int32Array(workerData.barrier);
        Atomics.add(barrier, 0, 1);
        Atomics.notify(barrier, 0);
        while (Atomics.load(barrier, 0) < 2) Atomics.wait(barrier, 0, 1, 5_000);
        migrateDatabase(database);
        database.close();
        parentPort.postMessage({ ok: true });
      })().catch((error) => parentPort.postMessage({ ok: false, error: error.stack }));
    `;
    const runWorker = () =>
      new Promise<void>((resolveP, rejectP) => {
        const worker = new Worker(workerSource, {
          eval: true,
          workerData: { dbPath, barrier, migrationSource },
        });
        worker.once("message", (message: { ok: boolean; error?: string }) => {
          if (message.ok) resolveP();
          else rejectP(new Error(message.error));
        });
        worker.once("error", rejectP);
      });

    try {
      await Promise.all([runWorker(), runWorker()]);
      const migrated = new Database(dbPath);
      expect(
        (migrated.pragma("table_info(reviews)") as { name: string }[]).map((column) => column.name),
      ).toEqual(
        expect.arrayContaining(["worker_token", "worker_pid", "added_threads", "stale_marked"]),
      );
      expect(
        (migrated.pragma("table_info(thread_actions)") as { name: string }[]).map(
          (column) => column.name,
        ),
      ).toEqual(
        expect.arrayContaining([
          "thread_id",
          "pr_id",
          "kind",
          "status",
          "heartbeat_at",
          "worker_token",
          "worker_pid",
        ]),
      );
      expect(
        (migrated.pragma("table_info(work_items)") as { name: string }[]).map(
          (column) => column.name,
        ),
      ).toEqual(
        expect.arrayContaining([
          "dedupe_key",
          "status",
          "heartbeat_at",
          "worker_token",
          "worker_pid",
          "attempt_count",
          "launch_count",
          "last_launch_at",
        ]),
      );
      expect(
        (migrated.pragma("table_info(work_events)") as { name: string }[]).map(
          (column) => column.name,
        ),
      ).toEqual(expect.arrayContaining(["work_id", "event", "created_at"]));
      migrated.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("adds current columns and preserves a PR override through the real refresh upsert", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE repos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        local_path TEXT NOT NULL,
        UNIQUE(owner, name)
      );
      CREATE TABLE prs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        head_sha TEXT NOT NULL,
        base_sha TEXT NOT NULL,
        head_ref TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        state TEXT NOT NULL,
        url TEXT NOT NULL,
        author TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(repo_id, number)
      );
    `);

    migrateDatabase(db);

    const repoColumns = db.pragma("table_info(repos)") as { name: string }[];
    const prColumns = db.pragma("table_info(prs)") as { name: string }[];
    expect(repoColumns.map((column) => column.name)).toContain("reviewer_provider");
    expect(prColumns.map((column) => column.name)).toContain("reviewer_provider");
    expect(prColumns.map((column) => column.name)).toContain("assignees");
    expect(prColumns.map((column) => column.name)).toContain("review_requests");
    expect(prColumns.map((column) => column.name)).toContain("created_at");

    const repoId = Number(
      db
        .prepare("INSERT INTO repos (owner, name, local_path) VALUES (?, ?, ?)")
        .run("owner", "repo", "/repo").lastInsertRowid,
    );
    db.prepare(
      `
        INSERT INTO prs (
          repo_id, number, title, body, head_sha, base_sha, head_ref, base_ref,
          state, url, author, updated_at, reviewer_provider
        ) VALUES (?, 16, 'Original', '', '', '', 'feature', 'main', 'OPEN', 'url', 'author', 'old', 'codex')
      `,
    ).run(repoId);

    db.prepare(OPEN_PR_UPSERT_SQL).run(
      repoId,
      16,
      "Refreshed",
      "feature",
      "main",
      "OPEN",
      "url",
      "author",
      "[]",
      '["reviewer"]',
      "created",
      "new",
    );

    const refreshed = db
      .prepare(
        "SELECT title, reviewer_provider, assignees, review_requests, created_at FROM prs WHERE repo_id = ? AND number = 16",
      )
      .get(repoId) as {
      title: string;
      reviewer_provider: string | null;
      assignees: string;
      review_requests: string;
      created_at: string;
    };
    expect(refreshed).toEqual({
      title: "Refreshed",
      reviewer_provider: "codex",
      assignees: "[]",
      review_requests: '["reviewer"]',
      created_at: "created",
    });
  });

  it("retires legacy duplicate active reviews and enforces one active review per PR", () => {
    db = new Database(":memory:");
    migrateDatabase(db);
    db.exec("DROP INDEX idx_reviews_one_running_per_pr");
    db.prepare("INSERT INTO repos (id, owner, name, local_path) VALUES (1, 'o', 'r', '/r')").run();
    db.prepare(
      `INSERT INTO prs
       (id, repo_id, number, title, body, head_sha, base_sha, head_ref, base_ref, state, url, updated_at)
       VALUES (1, 1, 1, 'PR', '', 'head', 'base', 'feature', 'main', 'OPEN', 'url', 'now')`,
    ).run();
    const insert = db.prepare(
      `INSERT INTO reviews (pr_id, head_sha, provider, status, started_at, heartbeat_at)
       VALUES (1, 'head', 'codex', 'running', ?, ?)`,
    );
    insert.run("2026-08-24T00:00:00.000Z", "2026-08-24T00:00:01.000Z");
    insert.run("2026-08-24T00:01:00.000Z", "2026-08-24T00:01:01.000Z");

    migrateDatabase(db);

    expect(db.prepare("SELECT id, status FROM reviews ORDER BY id").all()).toEqual([
      { id: 1, status: "error" },
      { id: 2, status: "running" },
    ]);
    expect(() => insert.run("later", "later")).toThrow(/UNIQUE constraint failed/);
  });

  it("enforces one active durable action per thread", () => {
    db = new Database(":memory:");
    migrateDatabase(db);
    db.prepare("INSERT INTO repos (id, owner, name, local_path) VALUES (1, 'o', 'r', '/r')").run();
    db.prepare(
      `INSERT INTO prs
       (id, repo_id, number, title, body, head_sha, base_sha, head_ref, base_ref, state, url, updated_at)
       VALUES (1, 1, 1, 'PR', '', 'head', 'base', 'feature', 'main', 'OPEN', 'url', 'now')`,
    ).run();
    db.prepare(
      `INSERT INTO threads
       (id, pr_id, file_path, line, side, severity, status, first_seen_sha, last_seen_sha, stale, created_at)
       VALUES (1, 1, 'src/a.ts', 1, 'RIGHT', 'concern', 'open', 'head', 'head', 0, 'now')`,
    ).run();
    const insert = db.prepare(
      `INSERT INTO thread_actions
       (thread_id, pr_id, kind, input, provider, status, started_at, heartbeat_at)
       VALUES (1, 1, 'revalidate', '', 'codex', 'running', 'now', 'now')`,
    );
    insert.run();
    expect(() => insert.run()).toThrow(/UNIQUE constraint failed/);
  });
});
