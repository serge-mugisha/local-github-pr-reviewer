import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "./db.js";
import { threadActionIdempotencyKey } from "./operations.js";
import {
  appendWorkEvent,
  claimWorkItem,
  completeWorkItem,
  enqueueReplyWork,
  enqueueWork,
  ensureWorkItemRunning,
  failWorkItem,
  findLatestWorkItem,
  getWorkItem,
  listWorkEvents,
  listWorkItems,
  pruneFinishedWorkEvents,
  pruneExpiredWorkItems,
  reconcileInterruptedWorkItems,
  resolveWorkerLaunch,
  resolveSupervisorLaunch,
  superviseWorkQueue,
  waitForWorkItem,
  type ReviewExecutionSnapshot,
} from "./workQueue.js";

const mocks = vi.hoisted(() => ({
  db: undefined as unknown as Database.Database,
  unref: vi.fn(),
  once: vi.fn(),
  spawn: vi.fn(),
  listeners: new Map<string, (...args: unknown[]) => void>(),
}));

vi.mock("./db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db.js")>();
  return { ...actual, getDb: () => mocks.db };
});

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => {
    mocks.spawn(...args);
    return { unref: mocks.unref, once: mocks.once };
  },
}));

beforeEach(() => {
  mocks.db = new Database(":memory:");
  migrateDatabase(mocks.db);
  mocks.spawn.mockReset();
  mocks.unref.mockReset();
  mocks.once.mockReset();
  mocks.listeners.clear();
  mocks.once.mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
    mocks.listeners.set(event, listener);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  mocks.db.close();
});

function reviewSnapshot(configFingerprint: string, updatedAt: string): ReviewExecutionSnapshot {
  return {
    pr: {
      id: 42,
      repo_id: 1,
      number: 25,
      title: "Durable operations",
      body: "",
      head_sha: "head",
      base_sha: "base",
      head_ref: "feature",
      base_ref: "main",
      state: "OPEN",
      url: "https://example.test/pr/25",
      author: "tester",
      assignees: "[]",
      review_requests: "[]",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: updatedAt,
      reviewer_provider: null,
    },
    providerId: "test",
    skills: "",
    config: {
      categories: [],
      strictness: "balanced",
      globalRules: "",
      repoRules: "",
      perPrRules: "",
      pathInclude: "",
      pathExclude: "",
    },
    openThreads: [],
    configFingerprint,
  };
}

function workerSpawnCount(workId: string): number {
  return mocks.spawn.mock.calls.filter((call) => (call[1] as unknown[]).includes(workId)).length;
}

describe("durable Reviewer work queue", () => {
  it("deduplicates active requests before launching detached workers", () => {
    const first = enqueueWork({ kind: "review", prId: 42 });
    const second = enqueueWork({ kind: "review", prId: 42 });

    expect(first.created).toBe(true);
    expect(second).toEqual({ workId: first.workId, created: false });
    expect(workerSpawnCount(first.workId)).toBe(1);
    expect(mocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining([first.workId]),
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
    expect(mocks.unref).toHaveBeenCalledTimes(2);
    expect(getWorkItem(first.workId)).toMatchObject({
      status: "queued",
      attempt_count: 0,
      launch_count: 1,
    });
  });

  it("uses tsx for the source worker during npm run dev", () => {
    const launch = resolveWorkerLaunch("dev-work", (path) => path.endsWith("worker.ts"));
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual([
      expect.stringContaining("tsx/dist/cli.mjs"),
      expect.stringMatching(/worker\.ts$/),
      "dev-work",
    ]);
  });

  it("resolves compiled and source supervisor entrypoints", () => {
    expect(resolveSupervisorLaunch((path) => path.endsWith("supervisor.js"))).toEqual({
      command: process.execPath,
      args: [expect.stringMatching(/supervisor\.js$/)],
    });
    expect(resolveSupervisorLaunch((path) => path.endsWith("supervisor.ts"))).toEqual({
      command: process.execPath,
      args: [expect.stringContaining("tsx/dist/cli.mjs"), expect.stringMatching(/supervisor\.ts$/)],
    });
    expect(() => resolveSupervisorLaunch(() => false)).toThrow(
      "Reviewer supervisor entrypoint is missing",
    );
  });

  it("persists provider progress for reconnecting UI consumers", () => {
    const queued = enqueueWork({ kind: "review", prId: 8 });
    appendWorkEvent(queued.workId, { type: "stderr", data: "reviewing file.ts" });
    expect(listWorkEvents(queued.workId)).toEqual([
      expect.objectContaining({
        work_id: queued.workId,
        event: JSON.stringify({ type: "stderr", data: "reviewing file.ts" }),
      }),
    ]);
  });

  it("reports durable work state while a caller waits", async () => {
    const queued = enqueueWork({ kind: "review", prId: 18 });
    const claim = claimWorkItem(queued.workId)!;
    const states: string[] = [];
    const waiting = waitForWorkItem(queued.workId, {
      onProgress: (work) => states.push(work.status),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    completeWorkItem(queued.workId, claim.workerToken, {});
    await waiting;

    expect(states[0]).toBe("running");
    expect(states.at(-1)).toBe("done");
  });

  it("allows a durable caller to wait without the default deadline", async () => {
    const dateNow = vi.spyOn(Date, "now");
    dateNow.mockReturnValue(0);
    const queued = enqueueWork({ kind: "review", prId: 19 });
    const claim = claimWorkItem(queued.workId)!;
    const waiting = waitForWorkItem(queued.workId, { timeoutMs: null });

    dateNow.mockReturnValue(22 * 60 * 1_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    completeWorkItem(queued.workId, claim.workerToken, {});

    await expect(waiting).resolves.toMatchObject({ status: "done" });
    dateNow.mockRestore();
  });

  it("returns a healthy running row when a bounded wait expires", async () => {
    const queued = enqueueWork({ kind: "review", prId: 20 });
    claimWorkItem(queued.workId);

    await expect(
      waitForWorkItem(queued.workId, { timeoutMs: 10, returnOnTimeout: true }),
    ).resolves.toMatchObject({ status: "running" });
  });

  it("deduplicates completed mutations by durable idempotency key", () => {
    const first = enqueueWork(
      { kind: "revalidate", threadId: 12, headSha: "head" },
      { idempotencyKey: "revalidate-12-head" },
    );
    const claim = claimWorkItem(first.workId)!;
    completeWorkItem(first.workId, claim.workerToken, { actionId: 3, resolved: true });

    const retry = enqueueWork(
      { kind: "revalidate", threadId: 12, headSha: "head" },
      { idempotencyKey: "revalidate-12-head" },
    );

    expect(retry).toEqual({ workId: first.workId, created: false });
    expect(workerSpawnCount(first.workId)).toBe(1);
  });

  it("releases an idempotency key after terminal failure", () => {
    const first = enqueueWork(
      { kind: "review", prId: 42 },
      { idempotencyKey: "review:42:retryable" },
    );
    const claim = claimWorkItem(first.workId)!;
    failWorkItem(first.workId, claim.workerToken, new Error("provider exploded"));

    const retry = enqueueWork(
      { kind: "review", prId: 42 },
      { idempotencyKey: "review:42:retryable" },
    );

    expect(retry).toMatchObject({ created: true });
    expect(retry.workId).not.toBe(first.workId);
  });

  it("joins semantically identical reviews despite volatile PR metadata", () => {
    const joinedBeforeCreate = vi.fn();
    const first = enqueueWork(
      { kind: "review", prId: 42, snapshot: reviewSnapshot("same-input", "old") },
      { idempotencyKey: "review:42:same-input" },
    );
    const activeRetry = enqueueWork(
      {
        kind: "review",
        prId: 42,
        snapshot: reviewSnapshot("same-input", "new"),
      },
      { beforeCreate: joinedBeforeCreate },
    );
    expect(activeRetry).toEqual({ workId: first.workId, created: false });
    expect(joinedBeforeCreate).not.toHaveBeenCalled();

    const claim = claimWorkItem(first.workId)!;
    completeWorkItem(first.workId, claim.workerToken, { reviewId: 7 });
    const completedRetry = enqueueWork(
      { kind: "review", prId: 42, snapshot: reviewSnapshot("same-input", "newer") },
      { idempotencyKey: "review:42:same-input" },
    );
    expect(completedRetry).toEqual({ workId: first.workId, created: false });
  });

  it("reports the PR when a different review is already active", () => {
    const rejectedBeforeCreate = vi.fn();
    enqueueWork({
      kind: "review",
      prId: 42,
      snapshot: reviewSnapshot("first-input", "old"),
    });

    expect(() =>
      enqueueWork(
        {
          kind: "review",
          prId: 42,
          snapshot: reviewSnapshot("different-input", "new"),
        },
        { beforeCreate: rejectedBeforeCreate },
      ),
    ).toThrow("PR 42 already has another active Reviewer action");
    expect(rejectedBeforeCreate).not.toHaveBeenCalled();
  });

  it("keeps status lookups read-only", () => {
    const queued = enqueueWork({ kind: "review", prId: 77 });
    mocks.db.pragma("query_only = ON");

    expect(getWorkItem(queued.workId)?.id).toBe(queued.workId);
    expect(listWorkItems()).toHaveLength(1);
    expect(findLatestWorkItem("review", 77)?.id).toBe(queued.workId);
  });

  it("allows only one process to claim and publish a queued item", () => {
    const queued = enqueueWork({ kind: "revalidate", threadId: 7 });
    const first = claimWorkItem(queued.workId);
    const second = claimWorkItem(queued.workId);

    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    completeWorkItem(queued.workId, first!.workerToken, { resolved: true });
    expect(getWorkItem(queued.workId)).toMatchObject({
      status: "done",
      result: JSON.stringify({ resolved: true }),
      attempt_count: 1,
    });
  });

  it("rejects a different mutation while a thread task is active", () => {
    enqueueWork({ kind: "reply", threadId: 7, message: "please explain" });
    expect(() => enqueueWork({ kind: "revalidate", threadId: 7 })).toThrow(
      "already has another active Reviewer action",
    );
  });

  it("persists a reply exactly once across a completed idempotent retry", () => {
    mocks.db
      .prepare("INSERT INTO repos (id, owner, name, local_path) VALUES (1, 'test', 'repo', '/tmp')")
      .run();
    mocks.db
      .prepare(
        `INSERT INTO prs
         (id, repo_id, number, title, head_sha, base_sha, head_ref, base_ref,
          state, url, updated_at)
         VALUES (1, 1, 1, 'PR', 'head-sha', 'base-sha', 'feature', 'main',
                 'OPEN', 'https://example.test/pr/1', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    mocks.db
      .prepare(
        `INSERT INTO threads
         (id, pr_id, status, first_seen_sha, last_seen_sha, created_at)
         VALUES (7, 1, 'open', 'head-sha', 'head-sha', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    const keyForCurrentContext = () =>
      threadActionIdempotencyKey("reply", 7, {
        headSha: "head-sha",
        providerId: "test",
        message: "please explain",
      });
    const firstKey = keyForCurrentContext();
    const first = enqueueReplyWork(7, "please explain", "head-sha", {
      providerId: "test",
      idempotencyKey: firstKey,
    });
    const claim = claimWorkItem(first.workId)!;
    completeWorkItem(first.workId, claim.workerToken, { actionId: 9 });
    const retryKey = keyForCurrentContext();
    const second = enqueueReplyWork(7, "please explain", "head-sha", {
      providerId: "test",
      idempotencyKey: retryKey,
    });
    const comments = mocks.db
      .prepare("SELECT author, body, head_sha FROM comments WHERE thread_id = ?")
      .all(7);

    expect(second).toEqual({ workId: first.workId, created: false });
    expect(retryKey).toBe(firstKey);
    expect(comments).toEqual([{ author: "user", body: "please explain", head_sha: "head-sha" }]);

    const failureKey = threadActionIdempotencyKey("reply", 7, {
      headSha: "head-sha",
      providerId: "test",
      message: "retry after failure",
    });
    const failed = enqueueReplyWork(7, "retry after failure", "head-sha", {
      providerId: "test",
      idempotencyKey: failureKey,
    });
    const failedClaim = claimWorkItem(failed.workId)!;
    failWorkItem(failed.workId, failedClaim.workerToken, new Error("provider unavailable"));
    const failureRetry = enqueueReplyWork(7, "retry after failure", "head-sha", {
      providerId: "test",
      idempotencyKey: failureKey,
    });
    expect(failureRetry.created).toBe(true);
    expect(
      mocks.db
        .prepare("SELECT COUNT(*) AS count FROM comments WHERE thread_id = 7 AND body = ?")
        .get("retry after failure"),
    ).toEqual({ count: 1 });
  });

  it("requeues a task whose worker disappeared and fences its stale token", () => {
    const queued = enqueueWork({ kind: "review", prId: 9 });
    const claim = claimWorkItem(queued.workId)!;
    mocks.db
      .prepare("UPDATE work_items SET worker_pid = ?, heartbeat_at = ? WHERE id = ?")
      .run(999_999_999, "2000-01-01T00:00:00.000Z", queued.workId);

    expect(reconcileInterruptedWorkItems()).toBe(1);
    expect(getWorkItem(queued.workId)).toMatchObject({
      status: "queued",
      worker_token: null,
      launch_count: 0,
      last_launch_at: null,
    });
    expect(() => completeWorkItem(queued.workId, claim.workerToken, {})).toThrow(
      "lost its worker lease",
    );
  });

  it("recovers a stale worker through the independent queue supervisor", async () => {
    const queued = enqueueWork({ kind: "review", prId: 10 });
    claimWorkItem(queued.workId);
    mocks.db
      .prepare("UPDATE work_items SET heartbeat_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", queued.workId);
    mocks.spawn.mockReset();
    mocks.spawn.mockImplementation((_command: string, args: unknown[]) => {
      if (args.includes(queued.workId)) {
        const recovered = claimWorkItem(queued.workId)!;
        completeWorkItem(queued.workId, recovered.workerToken, { recovered: true });
      }
    });

    await superviseWorkQueue(0);

    expect(workerSpawnCount(queued.workId)).toBe(1);
    expect(getWorkItem(queued.workId)).toMatchObject({
      status: "done",
      attempt_count: 2,
      result: JSON.stringify({ recovered: true }),
    });
  });

  it("allows only one queue supervisor lease at a time", async () => {
    const queued = enqueueWork({ kind: "review", prId: 11 });
    mocks.db
      .prepare(
        "INSERT INTO queue_supervisor_lease (id, token, heartbeat_at) VALUES (1, 'other', ?)",
      )
      .run(new Date().toISOString());
    mocks.spawn.mockReset();

    await superviseWorkQueue(0);

    expect(workerSpawnCount(queued.workId)).toBe(0);
  });

  it("surfaces a broken worker build instead of spawning forever", () => {
    vi.useFakeTimers();
    try {
      const queued = enqueueWork({ kind: "review", prId: 99 });
      for (let attempt = 1; attempt <= 3; attempt++) {
        mocks.listeners.get("exit")?.(1, null);
        expect(getWorkItem(queued.workId)?.error).toContain("exited before claiming");
        vi.advanceTimersByTime(5_001);
        if (attempt < 3) {
          ensureWorkItemRunning(queued.workId);
        }
      }
      ensureWorkItemRunning(queued.workId);
      expect(getWorkItem(queued.workId)).toMatchObject({
        status: "error",
        launch_count: 3,
        error: "Reviewer worker could not be launched after repeated launch failures.",
      });
      expect(mocks.spawn).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prunes progress for terminal work after the retention window", () => {
    const queued = enqueueWork({ kind: "review", prId: 123 });
    const claim = claimWorkItem(queued.workId)!;
    appendWorkEvent(queued.workId, { type: "stdout", data: "raw provider output" });
    completeWorkItem(queued.workId, claim.workerToken, {});
    mocks.db
      .prepare("UPDATE work_items SET finished_at = '2000-01-01T00:00:00.000Z' WHERE id = ?")
      .run(queued.workId);

    expect(pruneFinishedWorkEvents()).toBe(1);
    expect(listWorkEvents(queued.workId)).toEqual([]);
  });

  it("prunes only expired terminal operations and cascades their events", () => {
    const expired = enqueueWork({ kind: "review", prId: 124 });
    const retained = enqueueWork({ kind: "review", prId: 125 });
    const active = enqueueWork({ kind: "review", prId: 126 });
    for (const operation of [expired, retained]) {
      const claim = claimWorkItem(operation.workId)!;
      appendWorkEvent(operation.workId, { type: "log", data: "progress" });
      completeWorkItem(operation.workId, claim.workerToken, {});
    }
    mocks.db
      .prepare("UPDATE work_items SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id IN (?, ?)")
      .run(expired.workId, active.workId);
    mocks.db
      .prepare("UPDATE work_items SET expires_at = '2999-01-01T00:00:00.000Z' WHERE id = ?")
      .run(retained.workId);

    expect(pruneExpiredWorkItems()).toBe(1);
    expect(getWorkItem(expired.workId)).toBeUndefined();
    expect(listWorkEvents(expired.workId)).toEqual([]);
    expect(getWorkItem(retained.workId)?.status).toBe("done");
    expect(getWorkItem(active.workId)?.status).toBe("queued");
  });
});
