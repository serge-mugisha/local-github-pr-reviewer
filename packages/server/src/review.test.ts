import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase, type PrRow, type RepoRow } from "./db.js";
import { startReview } from "./review.js";

const mocks = vi.hoisted(() => ({
  db: undefined as unknown as Database.Database,
  pr: undefined as unknown as PrRow,
  review: vi.fn(),
  cleanup: vi.fn(),
}));

vi.mock("./db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db.js")>();
  return { ...actual, getDb: () => mocks.db };
});

vi.mock("./providers/index.js", () => ({
  getProvider: () => ({ review: mocks.review }),
}));

vi.mock("./skills.js", () => ({ getSkills: () => "" }));
vi.mock("./reviewConfig.js", () => ({
  getPrReviewConfig: () => ({
    categories: [],
    strictness: "balanced",
    customRules: "",
    pathInclude: "",
    pathExclude: "",
  }),
  getGlobalReviewConfig: () => ({ customRules: "" }),
}));
vi.mock("./github.js", () => ({ getPRDiff: vi.fn().mockResolvedValue("diff") }));
vi.mock("./prs.js", () => ({ hydratePR: () => Promise.resolve(mocks.pr) }));
vi.mock("./sessions.js", () => ({ recordSessions: vi.fn() }));
vi.mock("./prWorktree.js", () => ({
  preparePrHeadWorktree: () => Promise.resolve({ cwd: "/tmp/review-wt", cleanup: mocks.cleanup }),
}));

const repo: RepoRow = {
  id: 1,
  owner: "owner",
  name: "repo",
  local_path: "/tmp/repo",
  reviewer_provider: null,
};

beforeEach(() => {
  mocks.db = new Database(":memory:");
  migrateDatabase(mocks.db);
  mocks.db
    .prepare("INSERT INTO repos (id, owner, name, local_path) VALUES (?, ?, ?, ?)")
    .run(repo.id, repo.owner, repo.name, repo.local_path);
  mocks.db
    .prepare(
      `INSERT INTO prs
       (id, repo_id, number, title, body, head_sha, base_sha, head_ref, base_ref, state, url, author, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      10,
      repo.id,
      42,
      "PR",
      "Body",
      "head",
      "base",
      "feature",
      "main",
      "OPEN",
      "https://example.test/pr/42",
      "author",
      "2026-08-13T00:00:00.000Z",
    );
  mocks.pr = mocks.db.prepare("SELECT * FROM prs WHERE id = 10").get() as PrRow;
  mocks.review.mockReset();
  mocks.cleanup.mockReset();
  mocks.review.mockResolvedValue({
    summary: "Looks good",
    comments: [
      {
        path: "src/index.ts",
        line: 7,
        side: "RIGHT",
        severity: "concern",
        body: "A persisted finding",
      },
    ],
    rawOutput: "",
    sessionIds: [],
  });
});

afterEach(() => {
  mocks.db.close();
});

describe("startReview", () => {
  it("publishes committed results without waiting for worktree cleanup", async () => {
    mocks.cleanup.mockImplementation(() => new Promise<void>(() => {}));

    const started = startReview({ repo, pr: mocks.pr, providerId: "test" });
    const result = await started.completion;

    expect(result).toEqual({ reviewId: started.reviewId, addedThreads: 1, staleMarked: 0 });
    expect(mocks.cleanup).toHaveBeenCalledOnce();
    expect(
      mocks.db.prepare("SELECT status FROM reviews WHERE id = ?").get(started.reviewId),
    ).toEqual({ status: "done" });
    expect(mocks.db.prepare("SELECT COUNT(*) AS count FROM threads").get()).toEqual({ count: 1 });
  });

  it("keeps a committed review done when background cleanup rejects", async () => {
    mocks.cleanup.mockRejectedValue(new Error("cleanup failed"));

    const started = startReview({ repo, pr: mocks.pr, providerId: "test" });
    await expect(started.completion).resolves.toMatchObject({ reviewId: started.reviewId });
    await Promise.resolve();

    expect(
      mocks.db.prepare("SELECT status, error FROM reviews WHERE id = ?").get(started.reviewId),
    ).toEqual({ status: "done", error: null });
  });
});
