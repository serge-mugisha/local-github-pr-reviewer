import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  listRepos,
  getRepo,
  findRepoByOwnerName,
  syncReposFromConfig,
  getDb,
  type RepoRow,
} from "./db.js";
import { addRepoToConfig, removeRepoFromConfig } from "./config.js";
import { pickFolder } from "./folderPicker.js";
import { detectRepo } from "./repoDetect.js";
import {
  listPRsForRepo,
  refreshOpenPRs,
  getPRById,
  listThreadsForPR,
  hydratePR,
  clearReviewData,
} from "./prs.js";
import { getSkills, setSkills } from "./skills.js";
import { purgeSessionsForPrs } from "./sessions.js";
import {
  getGlobalReviewConfig,
  setGlobalReviewConfig,
  getPrReviewConfig,
  setPrReviewConfig,
  resetPrReviewConfig,
  prHasOwnSettings,
  listPresets,
  createPreset,
  updatePreset,
  deletePreset,
} from "./reviewConfig.js";
import { catalogForClient } from "./reviewCatalog.js";
import { buildReviewInstructions } from "./providers/prompt.js";
import {
  runReview,
  runReply,
  runRevalidate,
  setThreadStatus,
  reconcileInterruptedReviews,
} from "./review.js";
import * as gh from "./github.js";
import { listProviders, listProviderStatus, getProvider } from "./providers/index.js";
import { getSettings, setProvider } from "./settings.js";
import {
  describeReviewerProvider,
  resolveReviewerProvider,
  setPrReviewerProvider,
  setRepoReviewerProvider,
} from "./reviewerProvider.js";
import { listViewedFiles, setFileViewed } from "./viewedFiles.js";

function sseInit(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

function sseSend(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sseEnd(reply: FastifyReply): void {
  reply.raw.end();
}

function requireRepo(repoId: number): RepoRow {
  const r = getRepo(repoId);
  if (!r) throw new Error(`repo ${repoId} not found`);
  return r;
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/status", async () => {
    const [providers, auth] = await Promise.all([listProviderStatus(), gh.checkAuth()]);
    const settings = getSettings();
    return { providers, gh: auth, settings };
  });

  app.get("/api/settings", async () => getSettings());

  app.put("/api/settings", async (req) => {
    const body = z.object({ provider: z.string() }).parse(req.body);
    const prov = getProvider(body.provider); // throws if unknown
    setProvider(prov.id);
    return getSettings();
  });

  app.get("/api/repos", async () => {
    return listRepos().map((r) => ({
      id: r.id,
      owner: r.owner,
      name: r.name,
      localPath: r.local_path,
      reviewerProvider: describeReviewerProvider(r),
    }));
  });

  app.post("/api/repos/pick-folder", async () => {
    return { localPath: await pickFolder() };
  });

  app.post("/api/repos/detect", async (req) => {
    const body = z.object({ localPath: z.string().min(1) }).parse(req.body);
    const detected = await detectRepo(body.localPath);
    return detected;
  });

  app.post("/api/repos", async (req) => {
    const body = z.object({ localPath: z.string().min(1) }).parse(req.body);
    const detected = await detectRepo(body.localPath);
    const nextCfg = addRepoToConfig(detected);
    syncReposFromConfig(nextCfg.repos);
    const row = findRepoByOwnerName(detected.owner, detected.name);
    return { ...detected, id: row?.id };
  });

  app.put("/api/repos/:repoId/reviewer-provider", async (req) => {
    const { repoId } = z.object({ repoId: z.coerce.number() }).parse(req.params);
    const body = z.object({ provider: z.string().nullable() }).parse(req.body);
    requireRepo(repoId);
    const provider = body.provider ? getProvider(body.provider).id : null;
    setRepoReviewerProvider(repoId, provider);
    const updated = requireRepo(repoId);
    return { reviewerProvider: describeReviewerProvider(updated) };
  });

  app.delete("/api/repos/:repoId", async (req) => {
    const { repoId } = z.object({ repoId: z.coerce.number() }).parse(req.params);
    const repo = requireRepo(repoId);
    const nextCfg = removeRepoFromConfig(repo.owner, repo.name);
    // Delete AI chat sessions for this repo's PRs before the cascade removes
    // the tracking rows, so review sessions don't linger in CLI history.
    const prIds = (
      getDb().prepare("SELECT id FROM prs WHERE repo_id = ?").all(repoId) as { id: number }[]
    ).map((r) => r.id);
    await purgeSessionsForPrs(prIds);
    // Drop the repo row (cascades to PRs, threads, comments, skills).
    getDb().prepare("DELETE FROM repos WHERE id = ?").run(repoId);
    return { removed: { owner: repo.owner, name: repo.name }, remaining: nextCfg.repos.length };
  });

  app.get("/api/repos/:repoId/prs", async (req) => {
    const { repoId } = z.object({ repoId: z.coerce.number() }).parse(req.params);
    requireRepo(repoId);
    return listPRsForRepo(repoId);
  });

  app.post("/api/repos/:repoId/prs/refresh", async (req) => {
    const { repoId } = z.object({ repoId: z.coerce.number() }).parse(req.params);
    const repo = requireRepo(repoId);
    return refreshOpenPRs(repo);
  });

  app.get("/api/repos/:repoId/skills", async (req) => {
    const { repoId } = z.object({ repoId: z.coerce.number() }).parse(req.params);
    requireRepo(repoId);
    return { body: getSkills(repoId) };
  });

  app.put("/api/repos/:repoId/skills", async (req) => {
    const { repoId } = z.object({ repoId: z.coerce.number() }).parse(req.params);
    requireRepo(repoId);
    const body = z.object({ body: z.string() }).parse(req.body);
    setSkills(repoId, body.body);
    return { body: getSkills(repoId) };
  });

  // --- Review configuration: catalog, global defaults, presets ---

  const configBody = z.object({
    categories: z.array(z.string()).optional(),
    strictness: z.string().optional(),
    customRules: z.string().optional(),
  });

  app.get("/api/review-config/catalog", async () => catalogForClient());

  app.get("/api/review-config/global", async () => getGlobalReviewConfig());

  app.put("/api/review-config/global", async (req) => {
    const body = configBody.parse(req.body);
    return setGlobalReviewConfig(body);
  });

  app.get("/api/review-config/presets", async () => listPresets());

  app.post("/api/review-config/presets", async (req) => {
    const body = z
      .object({
        name: z.string().min(1),
        categories: z.array(z.string()).default([]),
        strictness: z.string().default("balanced"),
        customRules: z.string().default(""),
      })
      .parse(req.body);
    return createPreset(body);
  });

  app.put("/api/review-config/presets/:id", async (req) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const body = z
      .object({
        name: z.string().min(1).optional(),
        categories: z.array(z.string()).optional(),
        strictness: z.string().optional(),
        customRules: z.string().optional(),
      })
      .parse(req.body);
    return updatePreset(id, body);
  });

  app.delete("/api/review-config/presets/:id", async (req) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    deletePreset(id);
    return { ok: true };
  });

  // --- Per-PR review configuration ---

  app.get("/api/prs/:prId/review-config", async (req) => {
    const { prId } = z.object({ prId: z.coerce.number() }).parse(req.params);
    const pr = getPRById(prId);
    if (!pr) throw new Error(`pr ${prId} not found`);
    return { ...getPrReviewConfig(prId), customized: prHasOwnSettings(prId) };
  });

  app.put("/api/prs/:prId/review-config", async (req) => {
    const { prId } = z.object({ prId: z.coerce.number() }).parse(req.params);
    const pr = getPRById(prId);
    if (!pr) throw new Error(`pr ${prId} not found`);
    const body = z
      .object({
        categories: z.array(z.string()).optional(),
        strictness: z.string().optional(),
        customRules: z.string().optional(),
        pathInclude: z.string().optional(),
        pathExclude: z.string().optional(),
      })
      .parse(req.body);
    return { ...setPrReviewConfig(prId, body), customized: true };
  });

  app.delete("/api/prs/:prId/review-config", async (req) => {
    const { prId } = z.object({ prId: z.coerce.number() }).parse(req.params);
    const pr = getPRById(prId);
    if (!pr) throw new Error(`pr ${prId} not found`);
    return { ...resetPrReviewConfig(prId), customized: false };
  });

  // Preview the exact instruction block the model will receive. Reflects the
  // (possibly unsaved) config in the body, merged with stored global/repo rules.
  app.post("/api/prs/:prId/review-config/preview", async (req) => {
    const { prId } = z.object({ prId: z.coerce.number() }).parse(req.params);
    const pr = getPRById(prId);
    if (!pr) throw new Error(`pr ${prId} not found`);
    const body = z
      .object({
        categories: z.array(z.string()),
        strictness: z.string(),
        customRules: z.string().default(""),
        pathInclude: z.string().default(""),
        pathExclude: z.string().default(""),
      })
      .parse(req.body);
    const instructions = buildReviewInstructions({
      categories: body.categories,
      strictness: body.strictness,
      globalRules: getGlobalReviewConfig().customRules,
      repoRules: getSkills(pr.repo_id),
      perPrRules: body.customRules,
      pathInclude: body.pathInclude,
      pathExclude: body.pathExclude,
    });
    return { instructions };
  });

  app.get("/api/prs/:prId", async (req) => {
    const { prId } = z.object({ prId: z.coerce.number() }).parse(req.params);
    const pr = getPRById(prId);
    if (!pr) throw new Error(`pr ${prId} not found`);
    const repo = requireRepo(pr.repo_id);
    const refreshed = await hydratePR(repo, pr.number);
    const threads = listThreadsForPR(refreshed.id);
    reconcileInterruptedReviews();
    const lastReviewRow = getDb()
      .prepare("SELECT * FROM reviews WHERE pr_id = ? ORDER BY id DESC LIMIT 1")
      .get(refreshed.id) as
      | {
          id: number;
          head_sha: string;
          provider: string;
          status: string;
          summary: string | null;
          started_at: string;
          finished_at: string | null;
          error: string | null;
        }
      | undefined;
    const summaryReviewRow = getDb()
      .prepare(
        `
        SELECT * FROM reviews
        WHERE pr_id = ?
          AND status = 'done'
          AND TRIM(COALESCE(summary, '')) != ''
        ORDER BY id DESC
        LIMIT 1
      `,
      )
      .get(refreshed.id) as
      | {
          id: number;
          head_sha: string;
          provider: string;
          summary: string;
          finished_at: string | null;
        }
      | undefined;
    return {
      pr: {
        id: refreshed.id,
        number: refreshed.number,
        title: refreshed.title,
        body: refreshed.body,
        headSha: refreshed.head_sha,
        baseSha: refreshed.base_sha,
        headRef: refreshed.head_ref,
        baseRef: refreshed.base_ref,
        state: refreshed.state,
        url: refreshed.url,
        author: refreshed.author,
        updatedAt: refreshed.updated_at,
      },
      repo: { id: repo.id, owner: repo.owner, name: repo.name },
      reviewerProvider: describeReviewerProvider(repo, refreshed),
      reviewerProviders: listProviders().map((provider) => ({
        id: provider.id,
        displayName: provider.displayName,
      })),
      threads: threads.map((t) => ({
        id: t.id,
        filePath: t.file_path,
        line: t.line,
        side: t.side,
        severity: t.severity,
        status: t.status,
        stale: !!t.stale,
        firstSeenSha: t.first_seen_sha,
        lastSeenSha: t.last_seen_sha,
        comments: t.comments.map((c) => ({
          id: c.id,
          author: c.author,
          body: c.body,
          headSha: c.head_sha,
          kind: c.kind,
          createdAt: c.created_at,
        })),
      })),
      viewedFiles: listViewedFiles(refreshed.id, refreshed.head_sha),
      lastReview: lastReviewRow
        ? {
            id: lastReviewRow.id,
            headSha: lastReviewRow.head_sha,
            provider: lastReviewRow.provider,
            status: lastReviewRow.status,
            summary: lastReviewRow.summary,
            startedAt: lastReviewRow.started_at,
            finishedAt: lastReviewRow.finished_at,
            error: lastReviewRow.error,
          }
        : null,
      summaryReview: summaryReviewRow
        ? {
            id: summaryReviewRow.id,
            headSha: summaryReviewRow.head_sha,
            provider: summaryReviewRow.provider,
            summary: summaryReviewRow.summary,
            finishedAt: summaryReviewRow.finished_at,
          }
        : null,
    };
  });

  app.get("/api/prs/:prId/diff", async (req, reply) => {
    const { prId } = z.object({ prId: z.coerce.number() }).parse(req.params);
    const pr = getPRById(prId);
    if (!pr) throw new Error(`pr ${prId} not found`);
    const repo = requireRepo(pr.repo_id);
    const diff = await gh.getPRDiff(repo.owner, repo.name, pr.number);
    reply.header("content-type", "text/plain; charset=utf-8");
    return diff;
  });

  app.get("/api/prs/:prId/review/status", async (req) => {
    const { prId } = z.object({ prId: z.coerce.number() }).parse(req.params);
    if (!getPRById(prId)) throw new Error(`pr ${prId} not found`);
    reconcileInterruptedReviews();
    const row = getDb()
      .prepare("SELECT * FROM reviews WHERE pr_id = ? ORDER BY id DESC LIMIT 1")
      .get(prId) as
      | {
          id: number;
          head_sha: string;
          provider: string;
          status: string;
          summary: string | null;
          started_at: string;
          finished_at: string | null;
          error: string | null;
        }
      | undefined;
    return row
      ? {
          id: row.id,
          headSha: row.head_sha,
          provider: row.provider,
          status: row.status,
          summary: row.summary,
          startedAt: row.started_at,
          finishedAt: row.finished_at,
          error: row.error,
        }
      : null;
  });

  app.get("/api/prs/:prId/files", async (req) => {
    const { prId } = z.object({ prId: z.coerce.number() }).parse(req.params);
    const pr = getPRById(prId);
    if (!pr) throw new Error(`pr ${prId} not found`);
    const repo = requireRepo(pr.repo_id);
    return gh.getPRFiles(repo.owner, repo.name, pr.number);
  });

  app.post("/api/prs/:prId/viewed", async (req) => {
    const { prId } = z.object({ prId: z.coerce.number() }).parse(req.params);
    const body = z.object({ filePath: z.string().min(1), viewed: z.boolean() }).parse(req.body);
    const pr = getPRById(prId);
    if (!pr) throw new Error(`pr ${prId} not found`);
    setFileViewed(prId, body.filePath, pr.head_sha, body.viewed);
    return { viewedFiles: listViewedFiles(prId, pr.head_sha) };
  });

  app.put("/api/prs/:prId/reviewer-provider", async (req) => {
    const { prId } = z.object({ prId: z.coerce.number() }).parse(req.params);
    const body = z.object({ provider: z.string().nullable() }).parse(req.body);
    const pr = getPRById(prId);
    if (!pr) throw new Error(`pr ${prId} not found`);
    const provider = body.provider ? getProvider(body.provider).id : null;
    setPrReviewerProvider(prId, provider);
    const updated = getPRById(prId)!;
    const repo = requireRepo(updated.repo_id);
    return describeReviewerProvider(repo, updated);
  });

  // --- SSE actions ---

  app.post("/api/prs/:prId/review", async (req, reply) => {
    const { prId } = z.object({ prId: z.coerce.number() }).parse(req.params);
    const pr = getPRById(prId);
    if (!pr) throw new Error(`pr ${prId} not found`);
    const repo = requireRepo(pr.repo_id);
    const providerId = resolveReviewerProvider(repo, pr).provider;

    sseInit(reply);
    sseSend(reply, "log", { message: `starting review with ${providerId}…` });

    try {
      const result = await runReview({
        repo,
        pr,
        providerId,
        onProgress: (e) => sseSend(reply, e.type, e),
      });
      sseSend(reply, "done", result);
    } catch (e) {
      sseSend(reply, "error", { message: (e as Error).message });
    } finally {
      sseEnd(reply);
    }
  });

  app.post("/api/threads/:threadId/messages", async (req, reply) => {
    const { threadId } = z.object({ threadId: z.coerce.number() }).parse(req.params);
    const body = z.object({ body: z.string().min(1) }).parse(req.body);
    // We need the PR/repo for the thread.
    const row = (await import("./db.js"))
      .getDb()
      .prepare("SELECT pr_id FROM threads WHERE id = ?")
      .get(threadId) as { pr_id: number } | undefined;
    if (!row) throw new Error("thread not found");
    const pr = getPRById(row.pr_id);
    if (!pr) throw new Error("pr not found");
    const repo = requireRepo(pr.repo_id);
    const providerId = resolveReviewerProvider(repo, pr).provider;

    sseInit(reply);
    sseSend(reply, "log", { message: `replying with ${providerId}…` });
    try {
      const result = await runReply({
        repo,
        pr,
        threadId,
        userMessage: body.body,
        providerId,
        onProgress: (e) => sseSend(reply, e.type, e),
      });
      sseSend(reply, "done", result);
    } catch (e) {
      sseSend(reply, "error", { message: (e as Error).message });
    } finally {
      sseEnd(reply);
    }
  });

  app.post("/api/threads/:threadId/revalidate", async (req, reply) => {
    const { threadId } = z.object({ threadId: z.coerce.number() }).parse(req.params);
    const row = (await import("./db.js"))
      .getDb()
      .prepare("SELECT pr_id FROM threads WHERE id = ?")
      .get(threadId) as { pr_id: number } | undefined;
    if (!row) throw new Error("thread not found");
    const pr = getPRById(row.pr_id);
    if (!pr) throw new Error("pr not found");
    const repo = requireRepo(pr.repo_id);
    const providerId = resolveReviewerProvider(repo, pr).provider;

    sseInit(reply);
    sseSend(reply, "log", { message: `revalidating with ${providerId}…` });
    try {
      const result = await runRevalidate({
        repo,
        pr,
        threadId,
        providerId,
        onProgress: (e) => sseSend(reply, e.type, e),
      });
      sseSend(reply, "done", result);
    } catch (e) {
      sseSend(reply, "error", { message: (e as Error).message });
    } finally {
      sseEnd(reply);
    }
  });

  app.delete("/api/prs/:prId/review", async (req) => {
    const { prId } = z.object({ prId: z.coerce.number() }).parse(req.params);
    const pr = getPRById(prId);
    if (!pr) throw new Error(`pr ${prId} not found`);
    return clearReviewData(prId);
  });

  app.post("/api/threads/:threadId/status", async (req) => {
    const { threadId } = z.object({ threadId: z.coerce.number() }).parse(req.params);
    const body = z.object({ status: z.enum(["open", "resolved"]) }).parse(req.body);
    setThreadStatus(threadId, body.status);
    return { ok: true };
  });
}
