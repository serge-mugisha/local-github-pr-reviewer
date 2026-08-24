import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase, type PrRow, type RepoRow } from "./db.js";
import {
  abortLocalReviewWork,
  reconcileInterruptedReviews,
  startReview,
  waitForReview,
} from "./review.js";

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
  mocks.cleanup.mockResolvedValue(undefined);
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

  it("joins the active persisted review instead of launching a duplicate provider", async () => {
    let releaseProvider!: (value: Awaited<ReturnType<typeof mocks.review>>) => void;
    mocks.review.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseProvider = resolve;
        }),
    );

    const first = startReview({ repo, pr: mocks.pr, providerId: "test" });
    const second = startReview({ repo, pr: mocks.pr, providerId: "test" });

    expect(first.created).toBe(true);
    expect(second).toMatchObject({ reviewId: first.reviewId, created: false });
    expect(mocks.db.prepare("SELECT COUNT(*) AS count FROM reviews").get()).toEqual({ count: 1 });

    await vi.waitFor(() => expect(mocks.review).toHaveBeenCalledOnce());
    releaseProvider({
      summary: "Looks good",
      comments: [],
      rawOutput: "",
      sessionIds: [],
    });

    await expect(first.completion).resolves.toMatchObject({ reviewId: first.reviewId });
    await expect(second.completion).resolves.toEqual({
      reviewId: first.reviewId,
      addedThreads: 0,
      staleMarked: 0,
    });
    expect(mocks.review).toHaveBeenCalledOnce();
  });

  it("aborts only this process's joined waiters during shutdown", async () => {
    const reviewId = Number(
      mocks.db
        .prepare(
          `INSERT INTO reviews
             (pr_id, head_sha, provider, status, started_at, heartbeat_at, worker_token, worker_pid)
           VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`,
        )
        .run(
          mocks.pr.id,
          mocks.pr.head_sha,
          "external",
          new Date().toISOString(),
          new Date().toISOString(),
          "external-worker",
          process.pid,
        ).lastInsertRowid,
    );
    const joined = startReview({ repo, pr: mocks.pr, providerId: "test" });
    expect(joined).toMatchObject({ reviewId, created: false });

    expect(abortLocalReviewWork()).toBe(1);
    await expect(joined.completion).rejects.toThrow("Reviewer process is shutting down.");
    expect(mocks.db.prepare("SELECT status FROM reviews WHERE id = ?").get(reviewId)).toEqual({
      status: "running",
    });
    expect(mocks.review).not.toHaveBeenCalled();
  });

  it("aborts a locally owned review during shutdown", async () => {
    mocks.review.mockImplementation(
      (_ctx, _onProgress, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const started = startReview({ repo, pr: mocks.pr, providerId: "test" });
    const completion = expect(started.completion).rejects.toThrow(
      "Reviewer process is shutting down.",
    );
    await vi.waitFor(() => expect(mocks.review).toHaveBeenCalledOnce());

    expect(abortLocalReviewWork()).toBe(1);
    await completion;
    expect(
      mocks.db.prepare("SELECT status, error FROM reviews WHERE id = ?").get(started.reviewId),
    ).toEqual({ status: "error", error: "Reviewer process is shutting down." });
  });

  it("fences a stale worker from publishing after its lease is reclaimed", async () => {
    let releaseProvider!: (value: Awaited<ReturnType<typeof mocks.review>>) => void;
    mocks.review.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseProvider = resolve;
        }),
    );
    const stale = startReview({ repo, pr: mocks.pr, providerId: "test" });
    await vi.waitFor(() => expect(mocks.review).toHaveBeenCalledOnce());
    mocks.db
      .prepare(
        "UPDATE reviews SET status = 'error', finished_at = ?, error = 'lease reclaimed' WHERE id = ?",
      )
      .run(new Date().toISOString(), stale.reviewId);

    releaseProvider({
      summary: "stale result",
      comments: [
        {
          path: "src/stale.ts",
          line: 1,
          side: "RIGHT",
          severity: "concern",
          body: "must not publish",
        },
      ],
      rawOutput: "",
      sessionIds: [],
    });

    await expect(stale.completion).rejects.toThrow("lost its worker lease");
    expect(
      mocks.db.prepare("SELECT status, error FROM reviews WHERE id = ?").get(stale.reviewId),
    ).toEqual({ status: "error", error: "lease reclaimed" });
    expect(mocks.db.prepare("SELECT COUNT(*) AS count FROM threads").get()).toEqual({ count: 0 });
  });

  it("does not mark existing threads stale when a review fails", async () => {
    const threadId = Number(
      mocks.db
        .prepare(
          `INSERT INTO threads
             (pr_id, file_path, line, side, severity, status, first_seen_sha, last_seen_sha, stale, created_at)
           VALUES (?, ?, ?, 'RIGHT', 'concern', 'open', ?, ?, 0, ?)`,
        )
        .run(mocks.pr.id, "src/old.ts", 1, "old-head", "old-head", new Date().toISOString())
        .lastInsertRowid,
    );
    mocks.review.mockRejectedValue(new Error("provider failed"));

    const started = startReview({ repo, pr: mocks.pr, providerId: "test" });
    await expect(started.completion).rejects.toThrow("provider failed");

    expect(mocks.db.prepare("SELECT stale FROM threads WHERE id = ?").get(threadId)).toEqual({
      stale: 0,
    });
  });

  it("waits on persisted completion without depending on the owner promise", async () => {
    const startedAt = "2026-08-24T00:00:00.000Z";
    const reviewId = Number(
      mocks.db
        .prepare(
          `INSERT INTO reviews (pr_id, head_sha, provider, status, started_at, heartbeat_at)
           VALUES (?, ?, ?, 'running', ?, ?)`,
        )
        .run(mocks.pr.id, mocks.pr.head_sha, "test", startedAt, new Date().toISOString())
        .lastInsertRowid,
    );

    const waiting = waitForReview(reviewId, { pollIntervalMs: 5, timeoutMs: 1_000 });
    setTimeout(() => {
      mocks.db
        .prepare("UPDATE reviews SET status = 'done', finished_at = ? WHERE id = ?")
        .run("2026-08-24T00:01:00.000Z", reviewId);
    }, 10);

    await expect(waiting).resolves.toMatchObject({ id: reviewId, status: "done" });
  });

  it("does not reclaim a sleeping review while its owner process is alive", () => {
    const old = new Date(Date.now() - 60_000).toISOString();
    const reviewId = Number(
      mocks.db
        .prepare(
          `INSERT INTO reviews
             (pr_id, head_sha, provider, status, started_at, heartbeat_at, worker_token, worker_pid)
           VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`,
        )
        .run(mocks.pr.id, mocks.pr.head_sha, "test", old, old, "worker", process.pid)
        .lastInsertRowid,
    );

    expect(reconcileInterruptedReviews()).toBe(0);
    expect(mocks.db.prepare("SELECT status FROM reviews WHERE id = ?").get(reviewId)).toEqual({
      status: "running",
    });

    mocks.db.prepare("UPDATE reviews SET worker_pid = ? WHERE id = ?").run(999_999_999, reviewId);
    expect(reconcileInterruptedReviews()).toBe(1);
    expect(mocks.db.prepare("SELECT status FROM reviews WHERE id = ?").get(reviewId)).toEqual({
      status: "error",
    });
  });

  it("publishes a terminal error at the total lifecycle deadline", async () => {
    vi.useFakeTimers();
    try {
      mocks.review.mockImplementation(
        (_ctx, _onProgress, signal: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      );
      const started = startReview({ repo, pr: mocks.pr, providerId: "test" });
      const completion = expect(started.completion).rejects.toThrow(
        "Review exceeded the 20-minute total lifecycle limit.",
      );
      await vi.waitFor(() => expect(mocks.review).toHaveBeenCalledOnce());

      await vi.advanceTimersByTimeAsync(20 * 60 * 1_000);
      await completion;
      expect(
        mocks.db.prepare("SELECT status, error FROM reviews WHERE id = ?").get(started.reviewId),
      ).toEqual({
        status: "error",
        error: "Review exceeded the 20-minute total lifecycle limit.",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
