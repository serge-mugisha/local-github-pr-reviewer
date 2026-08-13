import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrateDatabase } from "./db.js";
import { LIST_PRS_SQL } from "./prs.js";

describe("LIST_PRS_SQL", () => {
  it("only marks successful reviews as reviewed and exposes the latest attempt status", () => {
    const db = new Database(":memory:");
    migrateDatabase(db);
    db.prepare(
      "INSERT INTO repos (id, owner, name, local_path) VALUES (1, 'o', 'r', '/tmp/r')",
    ).run();
    const insertPr = db.prepare(
      `INSERT INTO prs
       (id, repo_id, number, title, head_sha, base_sha, head_ref, base_ref, state, url, updated_at)
       VALUES (?, 1, ?, 'PR', 'head', 'base', 'feature', 'main', 'OPEN', 'url', 'now')`,
    );
    for (let id = 1; id <= 5; id++) insertPr.run(id, id);

    const insertReview = db.prepare(
      `INSERT INTO reviews (pr_id, head_sha, provider, status, started_at)
       VALUES (?, 'head', 'test', ?, 'now')`,
    );
    insertReview.run(2, "running");
    insertReview.run(3, "error");
    insertReview.run(4, "error");
    insertReview.run(4, "done");
    insertReview.run(5, "done");
    insertReview.run(5, "error");

    const rows = db.prepare(LIST_PRS_SQL).all(1) as Array<{
      id: number;
      hasReview: 0 | 1;
      reviewStatus: string | null;
    }>;

    expect(
      rows.map(({ id, hasReview, reviewStatus }) => ({ id, hasReview, reviewStatus })),
    ).toEqual([
      { id: 5, hasReview: 1, reviewStatus: "error" },
      { id: 4, hasReview: 1, reviewStatus: "done" },
      { id: 3, hasReview: 0, reviewStatus: "error" },
      { id: 2, hasReview: 0, reviewStatus: "running" },
      { id: 1, hasReview: 0, reviewStatus: null },
    ]);
    db.close();
  });
});
