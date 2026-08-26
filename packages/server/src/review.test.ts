import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase, type PrRow, type RepoRow } from "./db.js";
import { ReviewOutputParseError } from "./providers/parser.js";
import {
  abortLocalReviewWork,
  reconcileInterruptedThreadActions,
  reconcileInterruptedReviews,
  startReply,
  startRevalidate,
  startReview,
  waitForThreadAction,
  waitForReview,
} from "./review.js";

const mocks = vi.hoisted(() => ({
  db: undefined as unknown as Database.Database,
  pr: undefined as unknown as PrRow,
  review: vi.fn(),
  reply: vi.fn(),
  revalidate: vi.fn(),
  cleanup: vi.fn(),
  recordSessions: vi.fn(),
}));

vi.mock("./db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db.js")>();
  return { ...actual, getDb: () => mocks.db };
});

vi.mock("./providers/index.js", () => ({
  getProvider: () => ({
    review: mocks.review,
    reply: mocks.reply,
    revalidate: mocks.revalidate,
  }),
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
vi.mock("./sessions.js", () => ({ recordSessions: mocks.recordSessions }));
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
  mocks.reply.mockReset();
  mocks.revalidate.mockReset();
  mocks.cleanup.mockReset();
  mocks.recordSessions.mockReset();
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
  mocks.reply.mockResolvedValue({ body: "Reply", rawOutput: "", sessionIds: [] });
  mocks.revalidate.mockResolvedValue({
    resolved: true,
    body: "Fixed",
    rawOutput: "",
    sessionIds: [],
  });
});

afterEach(() => {
  mocks.db.close();
});

function createThread(): number {
  return Number(
    mocks.db
      .prepare(
        `INSERT INTO threads
           (pr_id, file_path, line, side, severity, status, first_seen_sha, last_seen_sha, stale, created_at)
         VALUES (?, 'src/index.ts', 7, 'RIGHT', 'concern', 'open', 'head', 'head', 0, ?)`,
      )
      .run(mocks.pr.id, new Date().toISOString()).lastInsertRowid,
  );
}

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

  it("retries one invalid provider response and publishes only the validated result", async () => {
    const onProgress = vi.fn();
    mocks.review
      .mockRejectedValueOnce(
        new ReviewOutputParseError("invalid first response", "not json", ["failed-session"]),
      )
      .mockResolvedValueOnce({
        summary: "Validated second response",
        comments: [],
        rawOutput: "valid json",
        sessionIds: ["successful-session"],
      });

    const started = startReview({ repo, pr: mocks.pr, providerId: "test", onProgress });
    await expect(started.completion).resolves.toEqual({
      reviewId: started.reviewId,
      addedThreads: 0,
      staleMarked: 0,
    });

    expect(mocks.review).toHaveBeenCalledTimes(2);
    expect(mocks.review.mock.calls[0]?.[0]).not.toHaveProperty("retryFeedback");
    expect(mocks.review.mock.calls[1]?.[0]).toMatchObject({
      retryFeedback: "invalid first response",
    });
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ type: "log", data: expect.stringContaining("Retrying") }),
    );
    expect(mocks.recordSessions).toHaveBeenCalledWith(
      mocks.pr.id,
      "test",
      ["failed-session"],
      "/tmp/review-wt",
    );
    expect(
      mocks.db.prepare("SELECT status, summary FROM reviews WHERE id = ?").get(started.reviewId),
    ).toEqual({ status: "done", summary: "Validated second response" });
  });

  it("fails the review explicitly when both provider responses are invalid", async () => {
    mocks.review
      .mockRejectedValueOnce(new ReviewOutputParseError("first invalid response", "bad one"))
      .mockRejectedValueOnce(new ReviewOutputParseError("second invalid response", "bad two"));

    const started = startReview({ repo, pr: mocks.pr, providerId: "test" });
    await expect(started.completion).rejects.toThrow(
      'AI reviewer output was invalid after 2 attempts. second invalid response Output excerpt: "bad two".',
    );

    expect(mocks.review).toHaveBeenCalledTimes(2);
    expect(
      mocks.db
        .prepare("SELECT status, summary, error FROM reviews WHERE id = ?")
        .get(started.reviewId),
    ).toEqual({
      status: "error",
      summary: null,
      error:
        'AI reviewer output was invalid after 2 attempts. second invalid response Output excerpt: "bad two".',
    });
    expect(mocks.db.prepare("SELECT COUNT(*) AS count FROM threads").get()).toEqual({ count: 0 });
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
    expect(mocks.review).toHaveBeenCalledOnce();

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

  it("fences a stale heartbeat even when its recorded PID is alive", () => {
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
        "Review exceeded the 35-minute total lifecycle limit.",
      );
      await vi.waitFor(() => expect(mocks.review).toHaveBeenCalledOnce());

      await vi.advanceTimersByTimeAsync(35 * 60 * 1_000);
      await completion;
      expect(
        mocks.db.prepare("SELECT status, error FROM reviews WHERE id = ?").get(started.reviewId),
      ).toEqual({
        status: "error",
        error: "Review exceeded the 35-minute total lifecycle limit.",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("durable thread actions", () => {
  it("joins duplicate replies and atomically publishes comments with completion", async () => {
    const threadId = createThread();
    let releaseReply!: (value: { body: string; rawOutput: string; sessionIds: string[] }) => void;
    mocks.reply.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseReply = resolve;
        }),
    );

    const first = startReply({
      repo,
      pr: mocks.pr,
      threadId,
      userMessage: "I patched this.",
      providerId: "test",
    });
    const second = startReply({
      repo,
      pr: mocks.pr,
      threadId,
      userMessage: "I patched this.",
      providerId: "test",
    });

    expect(first.created).toBe(true);
    expect(second).toMatchObject({ actionId: first.actionId, created: false });
    await vi.waitFor(() => expect(mocks.reply).toHaveBeenCalledOnce());
    releaseReply({ body: "Confirmed.", rawOutput: "", sessionIds: [] });

    await expect(first.completion).resolves.toMatchObject({ aiCommentId: expect.any(Number) });
    await expect(second.completion).resolves.toMatchObject({ aiCommentId: expect.any(Number) });
    expect(
      mocks.db
        .prepare("SELECT status, result FROM thread_actions WHERE id = ?")
        .get(first.actionId),
    ).toMatchObject({ status: "done", result: expect.stringContaining("aiCommentId") });
    expect(
      mocks.db
        .prepare("SELECT author, body FROM comments WHERE thread_id = ? ORDER BY id")
        .all(threadId),
    ).toEqual([
      { author: "user", body: "I patched this." },
      { author: "ai", body: "Confirmed." },
    ]);
  });

  it("fences a reclaimed reply without publishing stale AI output", async () => {
    const threadId = createThread();
    let releaseReply!: (value: { body: string; rawOutput: string; sessionIds: string[] }) => void;
    mocks.reply.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseReply = resolve;
        }),
    );
    const started = startReply({
      repo,
      pr: mocks.pr,
      threadId,
      userMessage: "Do not publish this twice.",
      providerId: "test",
    });
    await vi.waitFor(() => expect(mocks.reply).toHaveBeenCalledOnce());
    mocks.db
      .prepare(
        "UPDATE thread_actions SET status = 'error', finished_at = ?, error = 'lease reclaimed' WHERE id = ?",
      )
      .run(new Date().toISOString(), started.actionId);

    releaseReply({ body: "Stale reply", rawOutput: "", sessionIds: [] });
    await expect(started.completion).rejects.toThrow("lost its worker lease");
    expect(
      mocks.db
        .prepare("SELECT author, body FROM comments WHERE thread_id = ? ORDER BY id")
        .all(threadId),
    ).toEqual([{ author: "user", body: "Do not publish this twice." }]);
  });

  it("keeps the user's submitted reply when the provider fails", async () => {
    const threadId = createThread();
    mocks.reply.mockRejectedValue(new Error("provider unavailable"));

    const started = startReply({
      repo,
      pr: mocks.pr,
      threadId,
      userMessage: "Please keep this message.",
      providerId: "test",
    });

    await expect(started.completion).rejects.toThrow("provider unavailable");
    expect(
      mocks.db
        .prepare("SELECT author, body FROM comments WHERE thread_id = ? ORDER BY id")
        .all(threadId),
    ).toEqual([{ author: "user", body: "Please keep this message." }]);
    expect(
      mocks.db
        .prepare("SELECT status, error FROM thread_actions WHERE id = ?")
        .get(started.actionId),
    ).toEqual({ status: "error", error: "provider unavailable" });
  });

  it("rejects conflicting active actions and differing reply input", async () => {
    const replyThreadId = createThread();
    let releaseReply!: (value: { body: string; rawOutput: string; sessionIds: string[] }) => void;
    mocks.reply.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseReply = resolve;
        }),
    );
    const activeReply = startReply({
      repo,
      pr: mocks.pr,
      threadId: replyThreadId,
      userMessage: "original",
      providerId: "test",
    });
    expect(() =>
      startRevalidate({ repo, pr: mocks.pr, threadId: replyThreadId, providerId: "test" }),
    ).toThrow(`Thread ${replyThreadId} already has active reply action ${activeReply.actionId}`);
    expect(() =>
      startReply({
        repo,
        pr: mocks.pr,
        threadId: replyThreadId,
        userMessage: "different",
        providerId: "test",
      }),
    ).toThrow(`Thread ${replyThreadId} already has active reply action ${activeReply.actionId}`);
    await vi.waitFor(() => expect(mocks.reply).toHaveBeenCalledOnce());
    releaseReply({ body: "done", rawOutput: "", sessionIds: [] });
    await activeReply.completion;

    const revalidateThreadId = createThread();
    let releaseRevalidate!: (value: {
      resolved: boolean;
      body: string;
      rawOutput: string;
      sessionIds: string[];
    }) => void;
    mocks.revalidate.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRevalidate = resolve;
        }),
    );
    const activeRevalidate = startRevalidate({
      repo,
      pr: mocks.pr,
      threadId: revalidateThreadId,
      providerId: "test",
    });
    expect(() =>
      startReply({
        repo,
        pr: mocks.pr,
        threadId: revalidateThreadId,
        userMessage: "conflict",
        providerId: "test",
      }),
    ).toThrow(
      `Thread ${revalidateThreadId} already has active revalidate action ${activeRevalidate.actionId}`,
    );
    await vi.waitFor(() => expect(mocks.revalidate).toHaveBeenCalledOnce());
    releaseRevalidate({ resolved: false, body: "not yet", rawOutput: "", sessionIds: [] });
    await activeRevalidate.completion;
  });

  it("passes the lifecycle AbortSignal to reply and revalidation providers", async () => {
    const replyThreadId = createThread();
    const reply = startReply({
      repo,
      pr: mocks.pr,
      threadId: replyThreadId,
      userMessage: "signal check",
      providerId: "test",
    });
    await reply.completion;
    expect(mocks.reply.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);

    const revalidateThreadId = createThread();
    const revalidate = startRevalidate({
      repo,
      pr: mocks.pr,
      threadId: revalidateThreadId,
      providerId: "test",
    });
    await revalidate.completion;
    expect(mocks.revalidate.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
  });

  it("commits revalidation, resolution, and durable completion together", async () => {
    const threadId = createThread();
    const started = startRevalidate({ repo, pr: mocks.pr, threadId, providerId: "test" });

    await expect(started.completion).resolves.toMatchObject({
      resolved: true,
      commentId: expect.any(Number),
    });
    expect(
      mocks.db.prepare("SELECT status FROM thread_actions WHERE id = ?").get(started.actionId),
    ).toEqual({ status: "done" });
    expect(mocks.db.prepare("SELECT status FROM threads WHERE id = ?").get(threadId)).toEqual({
      status: "resolved",
    });
    expect(mocks.db.prepare("SELECT kind FROM comments WHERE thread_id = ?").get(threadId)).toEqual(
      { kind: "revalidate-resolved" },
    );
  });

  it("waits on persisted action completion after the owner promise is gone", async () => {
    const threadId = createThread();
    const actionId = Number(
      mocks.db
        .prepare(
          `INSERT INTO thread_actions
             (thread_id, pr_id, kind, input, provider, status, started_at, heartbeat_at)
           VALUES (?, ?, 'revalidate', '', 'test', 'running', ?, ?)`,
        )
        .run(threadId, mocks.pr.id, new Date().toISOString(), new Date().toISOString())
        .lastInsertRowid,
    );
    const waiting = waitForThreadAction(actionId, { pollIntervalMs: 5, timeoutMs: 1_000 });
    setTimeout(() => {
      mocks.db
        .prepare(
          "UPDATE thread_actions SET status = 'done', result = ?, finished_at = ? WHERE id = ?",
        )
        .run(JSON.stringify({ resolved: true, commentId: 1 }), new Date().toISOString(), actionId);
    }, 10);

    await expect(waiting).resolves.toMatchObject({ id: actionId, status: "done" });
  });

  it("turns an interrupted owner into a terminal action error", () => {
    const threadId = createThread();
    const old = new Date(Date.now() - 60_000).toISOString();
    const actionId = Number(
      mocks.db
        .prepare(
          `INSERT INTO thread_actions
             (thread_id, pr_id, kind, input, provider, status, started_at, heartbeat_at, worker_token, worker_pid)
           VALUES (?, ?, 'revalidate', '', 'test', 'running', ?, ?, 'dead-worker', ?)`,
        )
        .run(threadId, mocks.pr.id, old, old, 999_999_999).lastInsertRowid,
    );

    expect(reconcileInterruptedThreadActions()).toBe(1);
    expect(
      mocks.db.prepare("SELECT status, error FROM thread_actions WHERE id = ?").get(actionId),
    ).toEqual({ status: "error", error: "Thread action interrupted before completion." });
  });
});
