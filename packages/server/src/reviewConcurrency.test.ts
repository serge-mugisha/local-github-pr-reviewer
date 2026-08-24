import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { Worker } from "node:worker_threads";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDatabase } from "./db.js";
import { claimReview } from "./review.js";

describe("cross-process review claim", () => {
  it("returns one durable review id to two simultaneous SQLite connections", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reviewer-claim-"));
    const dbPath = join(dir, "reviewer.db");
    const setup = new Database(dbPath);
    migrateDatabase(setup);
    setup
      .prepare("INSERT INTO repos (id, owner, name, local_path) VALUES (1, 'o', 'r', '/r')")
      .run();
    setup
      .prepare(
        `INSERT INTO prs
         (id, repo_id, number, title, body, head_sha, base_sha, head_ref, base_ref, state, url, updated_at)
         VALUES (1, 1, 1, 'PR', '', 'head', 'base', 'feature', 'main', 'OPEN', 'url', 'now')`,
      )
      .run();
    setup.close();

    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const claimSource = claimReview.toString();
    const workerSource = `
      const { parentPort, workerData } = require("node:worker_threads");
      const Database = require("better-sqlite3");
      try {
        const claimReview = eval("(" + workerData.claimSource + ")");
        const database = new Database(workerData.dbPath);
        database.pragma("busy_timeout = 5000");
        const barrier = new Int32Array(workerData.barrier);
        Atomics.add(barrier, 0, 1);
        Atomics.notify(barrier, 0);
        while (Atomics.load(barrier, 0) < 2) Atomics.wait(barrier, 0, 1, 5_000);
        const result = claimReview(database, {
          prId: 1,
          headSha: "head",
          providerId: "codex",
          startedAt: new Date().toISOString(),
          workerToken: workerData.workerToken,
          workerPid: process.pid,
        });
        database.close();
        parentPort.postMessage({ ok: true, result });
      } catch (error) {
        parentPort.postMessage({ ok: false, error: error.stack });
      }
    `;
    const runWorker = (workerToken: string) =>
      new Promise<{ reviewId: number; created: boolean }>((resolveP, rejectP) => {
        const worker = new Worker(workerSource, {
          eval: true,
          workerData: { dbPath, barrier, claimSource, workerToken },
        });
        worker.once(
          "message",
          (message: {
            ok: boolean;
            result?: { reviewId: number; created: boolean };
            error?: string;
          }) => {
            if (message.ok && message.result) resolveP(message.result);
            else rejectP(new Error(message.error));
          },
        );
        worker.once("error", rejectP);
      });

    try {
      const results = await Promise.all([runWorker("worker-a"), runWorker("worker-b")]);
      expect(new Set(results.map((result) => result.reviewId)).size).toBe(1);
      expect(results.filter((result) => result.created)).toHaveLength(1);
      const verify = new Database(dbPath);
      expect(verify.prepare("SELECT COUNT(*) AS count FROM reviews").get()).toEqual({ count: 1 });
      verify.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
