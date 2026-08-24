import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { loadConfig } from "./config.js";
import { syncReposFromConfig, listRepos } from "./db.js";
import { purgeClosedForRepo } from "./prs.js";
import { pruneStaleWorktrees } from "./prWorktree.js";
import { registerRoutes } from "./routes.js";
import { shutdownActiveCliChildren } from "./providers/spawn.js";
import { abortLocalReviewWork } from "./review.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../../..");
const WEB_DIST = resolve(PROJECT_ROOT, "packages/web/dist");
const PID_FILE = resolve(PROJECT_ROOT, "data", "reviewer.pid");

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const raw = readFileSync(PID_FILE, "utf8").trim();
  const pid = Number(raw);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function writePidFile(): void {
  mkdirSync(dirname(PID_FILE), { recursive: true });
  writeFileSync(PID_FILE, String(process.pid));
}

function removePidFile(): void {
  try {
    unlinkSync(PID_FILE);
  } catch {
    /* ignore */
  }
}

async function gracefulShutdown(app: FastifyInstance, signal: string): Promise<void> {
  app.log.info(`received ${signal}, shutting down…`);
  abortLocalReviewWork();
  try {
    await Promise.all([app.close(), shutdownActiveCliChildren()]);
  } catch (e) {
    app.log.error(`error during shutdown: ${(e as Error).message}`);
  } finally {
    removePidFile();
    process.exit(0);
  }
}

function installSignalHandlers(app: FastifyInstance): void {
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
    process.on(sig, () => {
      void gracefulShutdown(app, sig);
    });
  }
  process.on("uncaughtException", (e) => {
    app.log.error(`uncaughtException: ${e.stack ?? e.message}`);
    void gracefulShutdown(app, "uncaughtException");
  });
  process.on("unhandledRejection", (e) => {
    app.log.error(`unhandledRejection: ${(e as Error).stack ?? String(e)}`);
  });
  // If our parent (the controlling shell, npm, or terminal) goes away, die with it.
  process.on("disconnect", () => {
    void gracefulShutdown(app, "disconnect");
  });
  if (typeof process.stdout?.on === "function") {
    // When the terminal closes, stdout becomes EPIPE; treat that as a shutdown signal.
    process.stdout.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EPIPE") void gracefulShutdown(app, "stdout-EPIPE");
    });
  }
}

async function handlePortConflict(port: number, host: string): Promise<void> {
  const existing = readPidFile();
  if (existing && isPidAlive(existing)) {
    console.error(
      `\nPort ${host}:${port} is already in use by reviewer (pid ${existing}).\n` +
        `That's almost certainly an orphan from a previous run.\n\n` +
        `Run one of these to free it:\n` +
        `  kill ${existing}\n` +
        `  npm run stop\n`,
    );
  } else {
    console.error(
      `\nPort ${host}:${port} is already in use by another process (not reviewer).\n` +
        `Find it with:  lsof -i :${port} -P -n\n` +
        `Then either stop that process or change "port" in config.json.\n`,
    );
  }
  process.exit(2);
}

async function main(): Promise<void> {
  const cfg = loadConfig();

  // If a previous run left a PID file with a dead PID, clear it.
  const prior = readPidFile();
  if (prior && !isPidAlive(prior)) removePidFile();

  syncReposFromConfig(cfg.repos);

  const app = Fastify({
    logger: {
      transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } },
    },
    bodyLimit: 10 * 1024 * 1024,
  });

  await app.register(cors, { origin: true });

  if (existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, { root: WEB_DIST });
    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith("/api")) {
        return reply.code(404).send({ error: "not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  await registerRoutes(app);

  // Cleanup-on-launch: drop local data for closed/merged PRs. Done in
  // parallel across repos to keep startup snappy; not awaited at all so the
  // server can begin accepting requests immediately.
  const repos = listRepos();
  void Promise.all(
    repos.map(async (repo) => {
      try {
        const removed = await purgeClosedForRepo(repo);
        if (removed > 0) {
          app.log.info(`purged ${removed} closed/merged PRs for ${repo.owner}/${repo.name}`);
        }
      } catch (e) {
        app.log.warn(`cleanup failed for ${repo.owner}/${repo.name}: ${(e as Error).message}`);
      }
    }),
  );

  void pruneStaleWorktrees(repos).catch((e) => {
    app.log.warn(`pruneStaleWorktrees failed: ${(e as Error).message}`);
  });

  installSignalHandlers(app);

  try {
    await app.listen({ host: cfg.host, port: cfg.port });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EADDRINUSE") {
      await handlePortConflict(cfg.port, cfg.host);
      return;
    }
    throw e;
  }
  writePidFile();
  app.log.info(`Reviewer ready at http://${cfg.host}:${cfg.port}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
