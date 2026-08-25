import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "./db.js";
import {
  appendWorkEvent,
  claimWorkItem,
  completeWorkItem,
  enqueueReplyWork,
  enqueueWork,
  ensureWorkItemRunning,
  getWorkItem,
  listWorkEvents,
  pruneFinishedWorkEvents,
  reconcileInterruptedWorkItems,
  resolveWorkerLaunch,
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

afterEach(() => mocks.db.close());

describe("durable Reviewer work queue", () => {
  it("deduplicates active requests before launching detached workers", () => {
    const first = enqueueWork({ kind: "review", prId: 42 });
    const second = enqueueWork({ kind: "review", prId: 42 });

    expect(first.created).toBe(true);
    expect(second).toEqual({ workId: first.workId, created: false });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining([first.workId]),
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
    expect(mocks.unref).toHaveBeenCalledTimes(1);
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

  it("persists a reply exactly once in the enqueue transaction", () => {
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
    const first = enqueueReplyWork(7, "please explain", "head-sha");
    const second = enqueueReplyWork(7, "please explain", "head-sha");
    const comments = mocks.db
      .prepare("SELECT author, body, head_sha FROM comments WHERE thread_id = ?")
      .all(7);

    expect(second).toEqual({ workId: first.workId, created: false });
    expect(comments).toEqual([{ author: "user", body: "please explain", head_sha: "head-sha" }]);
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
      expect(mocks.spawn).toHaveBeenCalledTimes(3);
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
});
