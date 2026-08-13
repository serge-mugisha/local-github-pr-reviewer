import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as api from "@reviewer/server/api";
import { resolveJobStatus, type Job } from "./jobStatus.js";

let nextJobId = 1;
const jobs = new Map<number, Job>();
const MAX_JOBS = 100;

function launchJob(
  type: string,
  promise: Promise<unknown>,
  metadata: Pick<Job, "reviewId" | "prId"> = {},
) {
  const jobId = nextJobId++;
  const job: Job = {
    id: jobId,
    status: "running",
    type,
    startedAt: new Date().toISOString(),
    ...metadata,
  };
  jobs.set(jobId, job);

  if (jobs.size > MAX_JOBS) {
    const oldestKeys = Array.from(jobs.keys()).slice(0, jobs.size - MAX_JOBS);
    for (const key of oldestKeys) {
      jobs.delete(key);
    }
  }

  promise
    .then((result) => {
      const job = jobs.get(jobId);
      if (job) {
        job.status = "completed";
        job.result = result;
        job.completedAt = new Date().toISOString();
      }
    })
    .catch((error) => {
      const job = jobs.get(jobId);
      if (job) {
        job.status = "error";
        job.error = String(error);
        job.completedAt = new Date().toISOString();
      }
    });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            jobId,
            status: "running",
            reviewId: metadata.reviewId,
            prId: metadata.prId,
          },
          null,
          2,
        ),
      },
    ],
  };
}

const server = new Server(
  {
    name: "reviewer-mcp",
    version: "0.3.1",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_system_status",
        description:
          "Returns the active AI provider, GitHub auth status, available categories (catalog), and registered presets.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "set_ai_provider",
        description: "Switches the global default AI reviewer provider.",
        inputSchema: {
          type: "object",
          properties: {
            providerId: {
              type: "string",
              description: "The ID of the provider (e.g. claude-3-5-sonnet)",
            },
          },
          required: ["providerId"],
        },
      },
      {
        name: "set_repo_reviewer_provider",
        description:
          "Sets or clears the default AI reviewer provider for a repository. A cleared override inherits the global default.",
        inputSchema: {
          type: "object",
          properties: {
            repoId: { type: "number" },
            providerId: {
              type: ["string", "null"],
              description: "Known provider ID, or null to inherit the global default",
            },
          },
          required: ["repoId", "providerId"],
        },
      },
      {
        name: "set_pr_reviewer_provider",
        description:
          "Sets or clears the AI reviewer provider override for one PR. A cleared override inherits its repository default, then the global default.",
        inputSchema: {
          type: "object",
          properties: {
            prId: { type: "number" },
            providerId: {
              type: ["string", "null"],
              description: "Known provider ID, or null to inherit repository/global defaults",
            },
          },
          required: ["prId", "providerId"],
        },
      },
      {
        name: "manage_repositories",
        description: "Action to list, add (detect), or remove local repositories.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["list", "add", "remove"] },
            localPath: { type: "string", description: "Path to repository (required for 'add')" },
            repoId: { type: "number", description: "Repository ID (required for 'remove')" },
          },
          required: ["action"],
        },
      },
      {
        name: "set_repo_skills",
        description: "Updates the repository-level custom instructions/skills.",
        inputSchema: {
          type: "object",
          properties: {
            repoId: { type: "number" },
            body: { type: "string", description: "Markdown text defining the skills/rules" },
          },
          required: ["repoId", "body"],
        },
      },
      {
        name: "list_prs",
        description: "Lists open PRs for a given repository.",
        inputSchema: {
          type: "object",
          properties: {
            repoId: { type: "number" },
          },
          required: ["repoId"],
        },
      },
      {
        name: "get_pr_details",
        description:
          "Gets refreshed PR context and diff from GitHub plus local review threads. For review results without network waits, use get_review_threads.",
        inputSchema: {
          type: "object",
          properties: {
            prId: { type: "number" },
          },
          required: ["prId"],
        },
      },
      {
        name: "get_review_threads",
        description:
          "Returns the latest persisted review status and all locally stored threads immediately, without refreshing GitHub or fetching the diff.",
        inputSchema: {
          type: "object",
          properties: { prId: { type: "number" } },
          required: ["prId"],
        },
      },
      {
        name: "clear_pr_review",
        description:
          "Deletes the existing AI review data for a PR, prepping it for a fresh review.",
        inputSchema: {
          type: "object",
          properties: {
            prId: { type: "number" },
          },
          required: ["prId"],
        },
      },
      {
        name: "manage_review_presets",
        description: "CRUD operations for review presets.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["list", "create", "update", "delete"] },
            presetId: { type: "number" },
            name: { type: "string" },
            categories: { type: "array", items: { type: "string" } },
            strictness: { type: "string" },
            customRules: { type: "string" },
          },
          required: ["action"],
        },
      },
      {
        name: "set_global_config",
        description: "Edits the default fallback rules and strictness across all PRs.",
        inputSchema: {
          type: "object",
          properties: {
            categories: { type: "array", items: { type: "string" } },
            strictness: { type: "string" },
            customRules: { type: "string" },
          },
          required: [],
        },
      },
      {
        name: "set_pr_config",
        description: "Applies PR-specific overrides before reviewing.",
        inputSchema: {
          type: "object",
          properties: {
            prId: { type: "number" },
            categories: { type: "array", items: { type: "string" } },
            strictness: { type: "string" },
            customRules: { type: "string" },
            pathInclude: { type: "string" },
            pathExclude: { type: "string" },
          },
          required: ["prId"],
        },
      },
      {
        name: "apply_preset",
        description: "Applies a specific review preset to a PR by its ID.",
        inputSchema: {
          type: "object",
          properties: {
            prId: { type: "number" },
            presetId: { type: "number" },
          },
          required: ["prId", "presetId"],
        },
      },
      {
        name: "get_job_status",
        description:
          "Checks an asynchronous job. Review jobs reconcile against persisted review state and return threads on completion; reviewId can recover status after an MCP restart.",
        inputSchema: {
          type: "object",
          properties: {
            jobId: { type: "number" },
            reviewId: { type: "number" },
          },
          anyOf: [{ required: ["jobId"] }, { required: ["reviewId"] }],
        },
      },
      {
        name: "trigger_review",
        description:
          "Runs the AI review using the PR provider override, repository default, or global default in that order.",
        inputSchema: {
          type: "object",
          properties: {
            prId: { type: "number" },
          },
          required: ["prId"],
        },
      },
      {
        name: "reply_to_thread",
        description: "Submits a reply message to a specific review thread.",
        inputSchema: {
          type: "object",
          properties: {
            threadId: { type: "number" },
            message: { type: "string" },
          },
          required: ["threadId", "message"],
        },
      },
      {
        name: "revalidate_thread",
        description:
          "Triggers an AI re-check of an open thread to see if recent commits resolved it.",
        inputSchema: {
          type: "object",
          properties: {
            threadId: { type: "number" },
          },
          required: ["threadId"],
        },
      },
      {
        name: "set_thread_status",
        description: "Manually marks a thread as resolved or open.",
        inputSchema: {
          type: "object",
          properties: {
            threadId: { type: "number" },
            status: { type: "string", enum: ["open", "resolved"] },
          },
          required: ["threadId", "status"],
        },
      },
    ],
  };
});

function requireRepo(repoId: number) {
  const repo = api.getRepo(repoId);
  if (!repo) throw new McpError(ErrorCode.InvalidParams, `Repo ${repoId} not found`);
  return repo;
}

function requirePr(prId: number) {
  const pr = api.getPRById(prId);
  if (!pr) throw new McpError(ErrorCode.InvalidParams, `PR ${prId} not found`);
  return pr;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    switch (request.params.name) {
      case "get_system_status": {
        const [providers, auth] = await Promise.all([api.listProviderStatus(), api.checkAuth()]);
        const settings = api.getSettings();
        const presets = api.listPresets();
        const catalog = await api.catalogForClient();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ providers, auth, settings, presets, catalog }, null, 2),
            },
          ],
        };
      }
      case "set_ai_provider": {
        const { providerId } = z.object({ providerId: z.string() }).parse(request.params.arguments);
        const prov = api.getProvider(providerId); // throws if unknown
        api.setProvider(prov.id);
        return {
          content: [{ type: "text", text: JSON.stringify(api.getSettings(), null, 2) }],
        };
      }
      case "set_repo_reviewer_provider": {
        const { repoId, providerId } = z
          .object({ repoId: z.number(), providerId: z.string().nullable() })
          .parse(request.params.arguments);
        const repo = requireRepo(repoId);
        const provider = providerId ? api.getProvider(providerId).id : null;
        api.setRepoReviewerProvider(repoId, provider);
        const updated = requireRepo(repo.id);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  reviewerProvider: api.describeReviewerProvider(updated),
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      case "set_pr_reviewer_provider": {
        const { prId, providerId } = z
          .object({ prId: z.number(), providerId: z.string().nullable() })
          .parse(request.params.arguments);
        const pr = requirePr(prId);
        const provider = providerId ? api.getProvider(providerId).id : null;
        api.setPrReviewerProvider(prId, provider);
        const updated = requirePr(pr.id);
        const repo = requireRepo(updated.repo_id);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(api.describeReviewerProvider(repo, updated), null, 2),
            },
          ],
        };
      }
      case "manage_repositories": {
        const args = z
          .object({
            action: z.enum(["list", "add", "remove"]),
            localPath: z.string().optional(),
            repoId: z.number().optional(),
          })
          .parse(request.params.arguments);

        if (args.action === "list") {
          const repos = api.listRepos().map((repo) => ({
            id: repo.id,
            owner: repo.owner,
            name: repo.name,
            localPath: repo.local_path,
            reviewerProvider: api.describeReviewerProvider(repo),
          }));
          return { content: [{ type: "text", text: JSON.stringify(repos, null, 2) }] };
        } else if (args.action === "add") {
          if (!args.localPath) throw new Error("localPath required for add action");
          const detected = await api.detectRepo(args.localPath);
          const nextCfg = api.addRepoToConfig(detected);
          api.syncReposFromConfig(nextCfg.repos);
          const row = api.findRepoByOwnerName(detected.owner, detected.name);
          return {
            content: [
              { type: "text", text: JSON.stringify({ ...detected, id: row?.id }, null, 2) },
            ],
          };
        } else if (args.action === "remove") {
          if (!args.repoId) throw new Error("repoId required for remove action");
          const repo = requireRepo(args.repoId);
          api.removeRepoFromConfig(repo.owner, repo.name);
          api.getDb().prepare("DELETE FROM repos WHERE id = ?").run(repo.id);
          // The sessions purging is normally done via sessions.ts, let's just do the cascade delete directly via DB:
          api.getDb().prepare("DELETE FROM repos WHERE id = ?").run(repo.id);
          return { content: [{ type: "text", text: `Repo ${repo.owner}/${repo.name} removed.` }] };
        }
        break;
      }
      case "set_repo_skills": {
        const { repoId, body } = z
          .object({ repoId: z.number(), body: z.string() })
          .parse(request.params.arguments);
        requireRepo(repoId);
        api.setSkills(repoId, body);
        return { content: [{ type: "text", text: "Skills updated." }] };
      }
      case "list_prs": {
        const { repoId } = z.object({ repoId: z.number() }).parse(request.params.arguments);
        requireRepo(repoId);
        api.reconcileInterruptedReviews();
        await api.refreshOpenPRs(requireRepo(repoId)); // auto-refresh to be helpful
        return {
          content: [{ type: "text", text: JSON.stringify(api.listPRsForRepo(repoId), null, 2) }],
        };
      }
      case "get_pr_details": {
        const { prId } = z.object({ prId: z.number() }).parse(request.params.arguments);
        const pr = requirePr(prId);
        const repo = requireRepo(pr.repo_id);
        const refreshed = await api.hydratePR(repo, pr.number);
        const diff = await api.getPRDiff(repo.owner, repo.name, pr.number);
        const threads = api.listThreadsForPR(prId);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  pr: refreshed,
                  reviewerProvider: api.describeReviewerProvider(repo, refreshed),
                  threads,
                  diff,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      case "get_review_threads": {
        const { prId } = z.object({ prId: z.number() }).parse(request.params.arguments);
        const pr = requirePr(prId);
        api.reconcileInterruptedReviews();
        const review = api.getLatestReviewForPR(prId);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  pr,
                  review,
                  threads: api.listThreadsForPR(prId),
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      case "clear_pr_review": {
        const { prId } = z.object({ prId: z.number() }).parse(request.params.arguments);
        requirePr(prId);
        await api.clearReviewData(prId);
        return { content: [{ type: "text", text: "Review data cleared." }] };
      }
      case "manage_review_presets": {
        const args = request.params.arguments as Record<string, unknown>;
        if (args.action === "list")
          return { content: [{ type: "text", text: JSON.stringify(api.listPresets(), null, 2) }] };
        if (args.action === "create")
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  api.createPreset(args as Parameters<typeof api.createPreset>[0]),
                  null,
                  2,
                ),
              },
            ],
          };
        if (args.action === "update")
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  api.updatePreset(
                    args.presetId as number,
                    args as Parameters<typeof api.updatePreset>[1],
                  ),
                  null,
                  2,
                ),
              },
            ],
          };
        if (args.action === "delete") {
          api.deletePreset(args.presetId as number);
          return { content: [{ type: "text", text: "Deleted." }] };
        }
        break;
      }
      case "set_global_config": {
        const args = request.params.arguments as Record<string, unknown>;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                api.setGlobalReviewConfig(args as Parameters<typeof api.setGlobalReviewConfig>[0]),
                null,
                2,
              ),
            },
          ],
        };
      }
      case "set_pr_config": {
        const args = request.params.arguments as Record<string, unknown>;
        requirePr(args.prId as number);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                api.setPrReviewConfig(
                  args.prId as number,
                  args as Parameters<typeof api.setPrReviewConfig>[1],
                ),
                null,
                2,
              ),
            },
          ],
        };
      }
      case "apply_preset": {
        const { prId, presetId } = z
          .object({ prId: z.number(), presetId: z.number() })
          .parse(request.params.arguments);
        requirePr(prId);
        const preset = api.listPresets().find((p) => p.id === presetId);
        if (!preset) throw new McpError(ErrorCode.InvalidParams, `Preset ${presetId} not found`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                api.setPrReviewConfig(prId, {
                  categories: preset.categories,
                  strictness: preset.strictness,
                  customRules: preset.customRules,
                }),
                null,
                2,
              ),
            },
          ],
        };
      }
      case "get_job_status": {
        const { jobId, reviewId: requestedReviewId } = z
          .object({ jobId: z.number().optional(), reviewId: z.number().optional() })
          .refine((value) => value.jobId !== undefined || value.reviewId !== undefined, {
            message: "jobId or reviewId is required",
          })
          .parse(request.params.arguments);
        const resolved = resolveJobStatus(
          { jobId, reviewId: requestedReviewId },
          {
            getJob: (id) => jobs.get(id),
            getReview: api.getReview,
            getThreads: api.listThreadsForPR,
            reconcileInterruptedReviews: api.reconcileInterruptedReviews,
          },
        );
        return { content: [{ type: "text", text: JSON.stringify(resolved, null, 2) }] };
      }
      case "trigger_review": {
        const { prId } = z.object({ prId: z.number() }).parse(request.params.arguments);
        const pr = requirePr(prId);
        const repo = requireRepo(pr.repo_id);
        const providerId = api.resolveReviewerProvider(repo, pr).provider;

        const started = api.startReview({ repo, pr, providerId });
        return launchJob("review", started.completion, {
          reviewId: started.reviewId,
          prId,
        });
      }
      case "reply_to_thread": {
        const { threadId, message } = z
          .object({ threadId: z.number(), message: z.string() })
          .parse(request.params.arguments);
        const row = api.getDb().prepare("SELECT pr_id FROM threads WHERE id = ?").get(threadId) as
          | { pr_id: number }
          | undefined;
        if (!row) throw new McpError(ErrorCode.InvalidParams, "Thread not found");
        const pr = requirePr(row.pr_id);
        const repo = requireRepo(pr.repo_id);
        const providerId = api.resolveReviewerProvider(repo, pr).provider;

        return launchJob(
          "reply",
          api.runReply({ repo, pr, threadId, userMessage: message, providerId }),
        );
      }
      case "revalidate_thread": {
        const { threadId } = z.object({ threadId: z.number() }).parse(request.params.arguments);
        const row = api.getDb().prepare("SELECT pr_id FROM threads WHERE id = ?").get(threadId) as
          | { pr_id: number }
          | undefined;
        if (!row) throw new McpError(ErrorCode.InvalidParams, "Thread not found");
        const pr = requirePr(row.pr_id);
        const repo = requireRepo(pr.repo_id);
        const providerId = api.resolveReviewerProvider(repo, pr).provider;

        return launchJob("revalidate", api.runRevalidate({ repo, pr, threadId, providerId }));
      }
      case "set_thread_status": {
        const { threadId, status } = z
          .object({ threadId: z.number(), status: z.enum(["open", "resolved"]) })
          .parse(request.params.arguments);
        api.setThreadStatus(threadId, status);
        return { content: [{ type: "text", text: `Thread ${threadId} marked as ${status}.` }] };
      }
      default:
        throw new McpError(ErrorCode.MethodNotFound, "Unknown tool");
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${error.message}`);
    }
    return {
      content: [
        { type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` },
      ],
      isError: true,
    };
  }
  return { content: [{ type: "text", text: "Success" }] };
});

async function main() {
  const pruneStale = () =>
    api.pruneStaleWorktrees(api.listRepos()).catch((error) => {
      console.error(`Reviewer MCP worktree pruning failed: ${String(error)}`);
    });
  void pruneStale();
  const pruneTimer = setInterval(() => void pruneStale(), 30 * 60 * 1_000);
  pruneTimer.unref();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Reviewer MCP server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
