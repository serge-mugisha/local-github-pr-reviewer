import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "./db.js";
import { OPEN_PR_UPSERT_SQL } from "./prs.js";

let db: Database.Database | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

describe("PR schema migration", () => {
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
});
