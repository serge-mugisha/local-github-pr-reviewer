import { spawnCli } from "./providers/spawn.js";

/**
 * The ONLY module in this codebase that invokes the `gh` CLI.
 * Strictly read-only: no methods that mutate any GitHub state are exported,
 * and only safe subcommands are ever passed to the shared process-group runner.
 *
 * A unit test enforces that no other file invokes the gh executable directly.
 */

const ALLOWED_SUBCOMMANDS = new Set(["pr", "api", "auth"]);
const ALLOWED_PR_VERBS = new Set(["list", "view", "diff"]);

function validateGhArgs(args: string[]): void {
  if (args.length === 0 || !ALLOWED_SUBCOMMANDS.has(args[0]!)) {
    throw new Error(`gh subcommand not allowed: ${args[0]}`);
  }
  if (args[0] === "pr" && args[1] && !ALLOWED_PR_VERBS.has(args[1])) {
    throw new Error(`gh pr verb not allowed: ${args[1]}`);
  }
  if (args[0] === "api") {
    const hasMethod = args.some(
      (arg, index) =>
        (arg === "-X" || arg === "--method") && args[index + 1] && args[index + 1] !== "GET",
    );
    if (hasMethod) throw new Error("gh api: only GET is allowed");
  }
}

async function ghText(args: string[], signal?: AbortSignal): Promise<string> {
  validateGhArgs(args);
  const result = await spawnCli({ cmd: "gh", args, cwd: process.cwd(), signal });
  if (result.exitCode !== 0) {
    throw new Error(`gh ${args.join(" ")} exited ${result.exitCode}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

async function ghJson<T>(args: string[], signal?: AbortSignal): Promise<T> {
  const stdout = await ghText(args, signal);
  try {
    return stdout.trim() ? (JSON.parse(stdout) as T) : (undefined as unknown as T);
  } catch (error) {
    throw new Error(`gh ${args.join(" ")} returned non-JSON: ${(error as Error).message}`);
  }
}

export interface GhPRSummary {
  number: number;
  title: string;
  state: string;
  headRefName: string;
  baseRefName: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  author: { login: string } | null;
  assignees: { login: string }[];
  reviewRequests: { login?: string }[];
}

export interface GhPRDetail extends GhPRSummary {
  body: string;
  headRefOid: string;
  baseRefOid: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export async function checkAuth(): Promise<{ ok: boolean; message: string; login: string | null }> {
  try {
    await ghText(["auth", "status"]);
    const viewer = await ghJson<{ login: string }>(["api", "user"]);
    return { ok: true, message: "authenticated", login: viewer.login };
  } catch (e) {
    return { ok: false, message: (e as Error).message, login: null };
  }
}

export async function listOpenPRs(owner: string, name: string): Promise<GhPRSummary[]> {
  return ghJson<GhPRSummary[]>([
    "pr",
    "list",
    "--repo",
    `${owner}/${name}`,
    "--state",
    "open",
    "--limit",
    "200",
    "--json",
    "number,title,state,headRefName,baseRefName,url,isDraft,createdAt,updatedAt,author,assignees,reviewRequests",
  ]);
}

export async function listClosedPRs(owner: string, name: string): Promise<GhPRSummary[]> {
  const merged = await ghJson<GhPRSummary[]>([
    "pr",
    "list",
    "--repo",
    `${owner}/${name}`,
    "--state",
    "merged",
    "--limit",
    "200",
    "--json",
    "number,title,state,headRefName,baseRefName,url,isDraft,createdAt,updatedAt,author,assignees,reviewRequests",
  ]);
  const closed = await ghJson<GhPRSummary[]>([
    "pr",
    "list",
    "--repo",
    `${owner}/${name}`,
    "--state",
    "closed",
    "--limit",
    "200",
    "--json",
    "number,title,state,headRefName,baseRefName,url,isDraft,createdAt,updatedAt,author,assignees,reviewRequests",
  ]);
  return [...merged, ...closed];
}

export async function getPR(
  owner: string,
  name: string,
  number: number,
  signal?: AbortSignal,
): Promise<GhPRDetail> {
  return ghJson<GhPRDetail>(
    [
      "pr",
      "view",
      String(number),
      "--repo",
      `${owner}/${name}`,
      "--json",
      "number,title,state,headRefName,baseRefName,url,isDraft,createdAt,updatedAt,author,assignees,reviewRequests,body,headRefOid,baseRefOid,additions,deletions,changedFiles",
    ],
    signal,
  );
}

export async function getPRDiff(
  owner: string,
  name: string,
  number: number,
  signal?: AbortSignal,
): Promise<string> {
  return ghText(["pr", "diff", String(number), "--repo", `${owner}/${name}`], signal);
}

export interface GhFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export async function getPRFiles(owner: string, name: string, number: number): Promise<GhFile[]> {
  // Use the REST API via `gh api` (GET only) for per-file patches.
  const files = await ghJson<GhFile[]>([
    "api",
    `repos/${owner}/${name}/pulls/${number}/files`,
    "--paginate",
  ]);
  return files;
}
