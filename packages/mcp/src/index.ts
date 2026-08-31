import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetTaskRequestSchema,
  GetTaskPayloadRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
  type CallToolResult,
  type Task,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as api from "@reviewer/server/api";
import { resolveJobStatus } from "./jobStatus.js";
import { collectViewerPrs } from "./prDiscovery.js";
import { handleAwaitReview } from "./awaitReview.js";
import { handleAwaitThreadAction } from "./awaitThreadAction.js";
import { resolveThreadActionStatus, selectThreadAction } from "./threadActionStatus.js";

const TASK_TTL_MS = 24 * 60 * 60 * 1_000;
const TASK_POLL_INTERVAL_MS = 1_000;

function taskFromWork(work: api.WorkItemRow): Task {
  const status: Task["status"] =
    work.status === "done"
      ? "completed"
      : work.status === "error"
        ? "failed"
        : work.status === "cancelled"
          ? "cancelled"
          : "working";
  return {
    taskId: work.id,
    status,
    ttl: TASK_TTL_MS,
    createdAt: work.created_at,
    lastUpdatedAt: work.finished_at ?? work.heartbeat_at ?? work.started_at ?? work.created_at,
    pollInterval: TASK_POLL_INTERVAL_MS,
    statusMessage:
      work.status === "queued"
        ? "Queued for the detached Reviewer worker."
        : work.status === "running"
          ? `Reviewer worker ${work.worker_pid ?? "starting"} is running attempt ${work.attempt_count}.`
          : (work.error ?? `Reviewer ${work.kind} ${work.status}.`),
  };
}

function taskMode(request: { params: unknown }): boolean {
  const params = request.params as { task?: unknown; _meta?: { task?: unknown } };
  return Boolean(params.task ?? params._meta?.task);
}

function completedWorkResult(work: api.WorkItemRow): CallToolResult {
  const snapshot = api.operationSnapshot(work);
  return structuredResult(snapshot, work.status === "error" || work.status === "cancelled");
}

function structuredResult(value: object, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
    ...(isError ? { isError: true } : {}),
  };
}

const OPERATION_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    operationId: { type: "string" },
    kind: { type: "string", enum: ["review", "reply", "revalidate"] },
    status: {
      type: "string",
      enum: ["queued", "running", "completed", "failed", "cancelled"],
    },
    terminal: { type: "boolean" },
    phase: { type: "string" },
    created: { type: "boolean" },
    target: { type: "object" },
    headSha: { type: ["string", "null"] },
    statusMessage: { type: "string" },
  },
  required: [
    "operationId",
    "kind",
    "status",
    "terminal",
    "phase",
    "created",
    "target",
    "headSha",
    "statusMessage",
  ],
} as const;

const server = new Server(
  {
    name: "reviewer-mcp",
    version: "0.6.0",
  },
  {
    capabilities: {
      tools: {},
      tasks: { requests: { tools: { call: {} } } },
    },
    instructions:
      "All review state and threads are local, not GitHub comments. Long-running tools return a durable operation immediately on ordinary clients and a protocol-native MCP Task on Task-capable clients. For an ordinary operation, call wait_operation with the returned operationId; each bounded wait either returns the terminal result or a healthy running snapshot and is safe to repeat without timers or trigger retries. Reviewer snapshots the exact PR head, provider, configuration, and prior thread context before enqueue, validates provider output, and fails closed. Use verify_review_gate before accepting a completed review. Treat AI findings as advisory and deliberately patch, dismiss, revalidate, or resolve each open non-stale thread.",
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
        name: "list_my_prs",
        description:
          "Lists open PRs across all registered repositories that were authored by the authenticated GitHub user or have a pending review request for them. Returns repository context and the local prId needed by get_pr_details and trigger_review.",
        inputSchema: {
          type: "object",
          properties: {
            relationship: {
              type: "string",
              enum: ["authored", "review_requested", "authored_or_review_requested"],
              description:
                "Which PRs to return. Defaults to authored_or_review_requested for the complete personal review queue.",
            },
            sort: {
              type: "string",
              enum: ["oldest", "newest", "recently_updated"],
              description: "Sort by PR creation time or recent activity. Defaults to oldest.",
            },
            refresh: {
              type: "boolean",
              description:
                "Refresh every registered repository from GitHub before filtering. Defaults to true; false uses the local cache.",
            },
            limit: {
              type: "number",
              minimum: 1,
              maximum: 500,
              description:
                "Optional maximum results. The response still reports totalMatching before the limit.",
            },
          },
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
          "Returns the latest persisted review, latest correlated operation, and live local threads immediately.",
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
        name: "trigger_review",
        description:
          "Snapshots and queues one exact-head local AI review. Ordinary clients receive a durable operation immediately; call wait_operation with its operationId. Task-capable clients receive an MCP Task.",
        execution: { taskSupport: "optional" },
        outputSchema: OPERATION_OUTPUT_SCHEMA,
        inputSchema: {
          type: "object",
          properties: {
            prId: { type: "number" },
            presetId: {
              type: "number",
              description: "Optional preset to apply before starting a new review",
            },
            expectedHeadSha: {
              type: "string",
              description:
                "Optional exact PR head expected by the caller; enqueue fails if it moved",
            },
            forceNew: {
              type: "boolean",
              description: "Start a new pass even when an identical completed operation exists",
            },
          },
          required: ["prId"],
        },
      },
      {
        name: "get_operation",
        description:
          "Returns one durable Reviewer operation immediately and safely recovers its worker.",
        outputSchema: OPERATION_OUTPUT_SCHEMA,
        inputSchema: {
          type: "object",
          properties: { operationId: { type: "string" } },
          required: ["operationId"],
        },
      },
      {
        name: "wait_operation",
        description:
          "Waits up to 25 seconds for a durable operation. A wait expiry returns a healthy running snapshot, never a timeout error; repeat while terminal is false.",
        outputSchema: OPERATION_OUTPUT_SCHEMA,
        inputSchema: {
          type: "object",
          properties: {
            operationId: { type: "string" },
            waitMs: { type: "number", minimum: 0, maximum: api.MAX_OPERATION_WAIT_MS },
          },
          required: ["operationId"],
        },
      },
      {
        name: "verify_review_gate",
        description:
          "Refreshes GitHub and returns the canonical exact-head gate for a completed review operation.",
        outputSchema: OPERATION_OUTPUT_SCHEMA,
        inputSchema: {
          type: "object",
          properties: { operationId: { type: "string" } },
          required: ["operationId"],
        },
      },
      {
        name: "reply_to_thread",
        description:
          "Queues a durable local AI reply and immediately returns its operation. Nothing is posted to GitHub.",
        execution: { taskSupport: "optional" },
        outputSchema: OPERATION_OUTPUT_SCHEMA,
        inputSchema: {
          type: "object",
          properties: {
            threadId: { type: "number" },
            message: { type: "string" },
            forceNew: { type: "boolean" },
          },
          required: ["threadId", "message"],
        },
      },
      {
        name: "revalidate_thread",
        description:
          "Queues a durable exact-head AI revalidation and immediately returns its operation.",
        execution: { taskSupport: "optional" },
        outputSchema: OPERATION_OUTPUT_SCHEMA,
        inputSchema: {
          type: "object",
          properties: {
            threadId: { type: "number" },
            forceNew: { type: "boolean" },
          },
          required: ["threadId"],
        },
      },
      {
        name: "get_thread_action",
        description:
          "Returns one persisted thread-action snapshot immediately. Use actionId normally, or threadId once to recover the latest action after a lost response; do not poll it.",
        inputSchema: {
          type: "object",
          properties: {
            actionId: { type: "number" },
            threadId: { type: "number" },
          },
          anyOf: [{ required: ["actionId"] }, { required: ["threadId"] }],
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

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
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
      case "list_my_prs": {
        const args = z
          .object({
            relationship: z
              .enum(["authored", "review_requested", "authored_or_review_requested"])
              .default("authored_or_review_requested"),
            sort: z.enum(["oldest", "newest", "recently_updated"]).default("oldest"),
            refresh: z.boolean().default(true),
            limit: z.number().int().min(1).max(500).optional(),
          })
          .parse(request.params.arguments ?? {});
        const auth = await api.checkAuth();
        if (!auth.ok || !auth.login) {
          throw new Error(`GitHub authentication is required: ${auth.message}`);
        }

        const repos = api.listRepos();
        const refreshErrors: Array<{ repoId: number; repo: string; error: string }> = [];
        if (args.refresh) {
          const results = await Promise.allSettled(repos.map((repo) => api.refreshOpenPRs(repo)));
          results.forEach((result, index) => {
            if (result.status === "rejected") {
              const repo = repos[index]!;
              refreshErrors.push({
                repoId: repo.id,
                repo: `${repo.owner}/${repo.name}`,
                error: String(result.reason),
              });
            }
          });
        }
        api.reconcileInterruptedReviews();
        const result = collectViewerPrs({
          repos,
          getPrs: api.listPRsForRepo,
          viewerLogin: auth.login,
          relationship: args.relationship,
          sort: args.sort,
          limit: args.limit,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  viewerLogin: auth.login,
                  relationship: args.relationship,
                  sort: args.sort,
                  refreshed: args.refresh,
                  refreshErrors,
                  ...result,
                },
                null,
                2,
              ),
            },
          ],
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
        const latestOperation = api.getLatestOperation("review", prId);
        const compactOperation = latestOperation
          ? {
              ...latestOperation,
              ...(latestOperation.review
                ? {
                    review: {
                      reviewId: latestOperation.review.reviewId,
                      reviewedHeadSha: latestOperation.review.reviewedHeadSha,
                      currentHeadSha: latestOperation.review.currentHeadSha,
                      gate: latestOperation.review.gate,
                      summary: latestOperation.review.summary,
                    },
                  }
                : {}),
            }
          : undefined;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  pr,
                  review,
                  latestOperation: compactOperation,
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
            getJob: () => undefined,
            getReview: api.getReview,
            getThreads: api.listThreadsForPR,
            reconcileInterruptedReviews: api.reconcileInterruptedReviews,
          },
        );
        return { content: [{ type: "text", text: JSON.stringify(resolved, null, 2) }] };
      }
      case "get_operation": {
        const { operationId } = z
          .object({ operationId: z.string().uuid() })
          .parse(request.params.arguments);
        const snapshot = api.getOperation(operationId);
        return structuredResult(
          snapshot,
          snapshot.status === "failed" || snapshot.status === "cancelled",
        );
      }
      case "wait_operation": {
        const { operationId, waitMs } = z
          .object({
            operationId: z.string().uuid(),
            waitMs: z
              .number()
              .int()
              .min(0)
              .max(api.MAX_OPERATION_WAIT_MS)
              .default(api.OPERATION_POLL_INTERVAL_MS),
          })
          .parse(request.params.arguments);
        const snapshot = await api.waitOperation(operationId, waitMs, extra.signal);
        return structuredResult(
          snapshot,
          snapshot.status === "failed" || snapshot.status === "cancelled",
        );
      }
      case "verify_review_gate": {
        const { operationId } = z
          .object({ operationId: z.string().uuid() })
          .parse(request.params.arguments);
        const snapshot = await api.verifyReviewGate(operationId);
        return structuredResult(
          snapshot,
          snapshot.status === "failed" || snapshot.status === "cancelled",
        );
      }
      case "await_review": {
        const { reviewId, timeoutMs } = z
          .object({
            reviewId: z.number().int().positive(),
            timeoutMs: z
              .number()
              .int()
              .min(1_000)
              .max(api.DURABLE_WAIT_TIMEOUT_MS)
              .default(api.DURABLE_WAIT_TIMEOUT_MS),
          })
          .parse(request.params.arguments);
        const resolved = await handleAwaitReview(
          { reviewId, timeoutMs },
          {
            signal: extra.signal,
            progressToken: request.params._meta?.progressToken,
            sendProgress: (params) =>
              extra.sendNotification({ method: "notifications/progress", params }),
          },
          {
            waitForReview: api.waitForReview,
            getReview: api.getReview,
            getThreads: api.listThreadsForPR,
            reconcileInterruptedReviews: api.reconcileInterruptedReviews,
          },
        );
        return { content: [{ type: "text", text: JSON.stringify(resolved, null, 2) }] };
      }
      case "trigger_review": {
        const { prId, presetId, expectedHeadSha, forceNew } = z
          .object({
            prId: z.number(),
            presetId: z.number().int().positive().optional(),
            expectedHeadSha: z
              .string()
              .regex(/^[0-9a-f]{40}$/)
              .optional(),
            forceNew: z.boolean().default(false),
          })
          .parse(request.params.arguments);
        const pr = requirePr(prId);
        const repo = requireRepo(pr.repo_id);
        const preset =
          presetId === undefined
            ? undefined
            : api.listPresets().find((candidate) => candidate.id === presetId);
        if (presetId !== undefined && !preset) {
          throw new McpError(ErrorCode.InvalidParams, `Preset ${presetId} not found`);
        }
        api.resolveReviewerProvider(repo, pr);
        const presetConfig = preset
          ? {
              categories: preset.categories,
              strictness: preset.strictness,
              customRules: preset.customRules,
            }
          : undefined;
        const snapshot = await api.createReviewExecutionSnapshot(
          repo,
          pr,
          expectedHeadSha,
          presetConfig,
        );
        const queued = api.enqueueWork(
          { kind: "review", prId, snapshot },
          {
            idempotencyKey: forceNew ? undefined : api.reviewIdempotencyKey(snapshot),
            beforeCreate: presetConfig
              ? () => api.setPrReviewConfig(prId, presetConfig)
              : undefined,
          },
        );
        const work = api.getWorkItem(queued.workId)!;
        if (taskMode(request)) return { task: taskFromWork(work) };
        return structuredResult(
          api.operationSnapshot(work, queued.created),
          work.status === "error" || work.status === "cancelled",
        );
      }
      case "reply_to_thread": {
        const { threadId, message, forceNew } = z
          .object({
            threadId: z.number(),
            message: z.string().min(1),
            forceNew: z.boolean().default(false),
          })
          .parse(request.params.arguments);
        const row = api.getDb().prepare("SELECT pr_id FROM threads WHERE id = ?").get(threadId) as
          | { pr_id: number }
          | undefined;
        if (!row) throw new McpError(ErrorCode.InvalidParams, "Thread not found");
        const pr = requirePr(row.pr_id);
        const repo = requireRepo(pr.repo_id);
        const refreshed = await api.hydratePR(repo, pr.number);
        const providerId = api.resolveReviewerProvider(repo, refreshed).provider;
        const queued = api.enqueueReplyWork(threadId, message, refreshed.head_sha, {
          providerId,
          idempotencyKey: forceNew
            ? undefined
            : api.threadActionIdempotencyKey("reply", threadId, {
                headSha: refreshed.head_sha,
                providerId,
                message,
              }),
        });
        const work = api.getWorkItem(queued.workId)!;
        if (taskMode(request)) return { task: taskFromWork(work) };
        return structuredResult(
          api.operationSnapshot(work, queued.created),
          work.status === "error" || work.status === "cancelled",
        );
      }
      case "revalidate_thread": {
        const { threadId, forceNew } = z
          .object({ threadId: z.number(), forceNew: z.boolean().default(false) })
          .parse(request.params.arguments);
        const row = api.getDb().prepare("SELECT pr_id FROM threads WHERE id = ?").get(threadId) as
          | { pr_id: number }
          | undefined;
        if (!row) throw new McpError(ErrorCode.InvalidParams, "Thread not found");
        const pr = requirePr(row.pr_id);
        const repo = requireRepo(pr.repo_id);
        const refreshed = await api.hydratePR(repo, pr.number);
        const providerId = api.resolveReviewerProvider(repo, refreshed).provider;
        const contextVersion = api.getThreadActionContextVersion(threadId);
        const queued = api.enqueueWork(
          { kind: "revalidate", threadId, headSha: refreshed.head_sha, providerId },
          {
            idempotencyKey: forceNew
              ? undefined
              : api.threadActionIdempotencyKey("revalidate", threadId, {
                  headSha: refreshed.head_sha,
                  providerId,
                  contextVersion,
                }),
          },
        );
        const work = api.getWorkItem(queued.workId)!;
        if (taskMode(request)) return { task: taskFromWork(work) };
        return structuredResult(
          api.operationSnapshot(work, queued.created),
          work.status === "error" || work.status === "cancelled",
        );
      }
      case "get_thread_action": {
        const { actionId, threadId } = z
          .object({
            actionId: z.number().int().positive().optional(),
            threadId: z.number().int().positive().optional(),
          })
          .refine((value) => value.actionId !== undefined || value.threadId !== undefined, {
            message: "actionId or threadId is required",
          })
          .parse(request.params.arguments);
        api.reconcileInterruptedThreadActions();
        let action;
        try {
          action = selectThreadAction(
            { actionId, threadId },
            {
              getById: api.getThreadAction,
              getLatestForThread: api.getLatestThreadActionForThread,
            },
          );
        } catch (error) {
          throw new McpError(ErrorCode.InvalidParams, (error as Error).message);
        }
        return {
          content: [
            { type: "text", text: JSON.stringify(resolveThreadActionStatus(action), null, 2) },
          ],
        };
      }
      case "await_thread_action": {
        const { actionId, timeoutMs } = z
          .object({
            actionId: z.number().int().positive(),
            timeoutMs: z
              .number()
              .int()
              .min(1_000)
              .max(api.DURABLE_WAIT_TIMEOUT_MS)
              .default(api.DURABLE_WAIT_TIMEOUT_MS),
          })
          .parse(request.params.arguments);
        const resolved = await handleAwaitThreadAction(
          { actionId, timeoutMs },
          {
            signal: extra.signal,
            progressToken: request.params._meta?.progressToken,
            sendProgress: (params) =>
              extra.sendNotification({ method: "notifications/progress", params }),
          },
          { waitForThreadAction: api.waitForThreadAction },
        );
        return { content: [{ type: "text", text: JSON.stringify(resolved, null, 2) }] };
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

server.setRequestHandler(GetTaskRequestSchema, async (request) => {
  return taskFromWork(api.ensureWorkItemRunning(request.params.taskId));
});

server.setRequestHandler(GetTaskPayloadRequestSchema, async (request, extra) => {
  try {
    await api.waitForWorkItem(request.params.taskId, { signal: extra.signal });
  } catch (error) {
    const current = api.getWorkItem(request.params.taskId);
    if (!current || (current.status !== "error" && current.status !== "cancelled")) throw error;
    // Terminal errors are represented by the durable task result below.
  }
  const work = api.getWorkItem(request.params.taskId);
  if (!work) throw new McpError(ErrorCode.InvalidParams, "Reviewer task not found.");
  const result = completedWorkResult(work);
  result._meta = {
    ...(result._meta ?? {}),
    "io.modelcontextprotocol/related-task": { taskId: work.id },
  };
  return result;
});

async function main() {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
    const shutdown = () => {
      process.removeListener(signal, shutdown);
      api.abortLocalReviewWork();
      void api.shutdownActiveCliChildren().then(() => process.kill(process.pid, signal));
    };
    process.once(signal, shutdown);
  }
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
