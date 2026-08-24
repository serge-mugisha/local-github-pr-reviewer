import { spawn } from "node:child_process";

/**
 * The ONLY module in this codebase that invokes the `gh` CLI.
 * Strictly read-only: no methods that mutate any GitHub state are exported,
 * and only safe subcommands are ever passed to spawn.
 *
 * A unit test enforces that no other file calls spawn('gh', ...).
 */

const ALLOWED_SUBCOMMANDS = new Set(["pr", "api", "auth"]);
const ALLOWED_PR_VERBS = new Set(["list", "view", "diff"]);

function abortReason(signal: AbortSignal, command: string): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(String(signal.reason ?? `${command} was cancelled`));
}

function ghJson<T>(args: string[], signal?: AbortSignal): Promise<T> {
  return new Promise((resolveP, rejectP) => {
    if (signal?.aborted) {
      rejectP(abortReason(signal, "gh"));
      return;
    }
    if (args.length === 0 || !ALLOWED_SUBCOMMANDS.has(args[0]!)) {
      rejectP(new Error(`gh subcommand not allowed: ${args[0]}`));
      return;
    }
    if (args[0] === "pr" && args[1] && !ALLOWED_PR_VERBS.has(args[1])) {
      rejectP(new Error(`gh pr verb not allowed: ${args[1]}`));
      return;
    }
    if (args[0] === "api") {
      const hasMethod = args.some(
        (a, i) => (a === "-X" || a === "--method") && args[i + 1] && args[i + 1] !== "GET",
      );
      if (hasMethod) {
        rejectP(new Error("gh api: only GET is allowed"));
        return;
      }
    }
    const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let cancelled: Error | null = null;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      cancelled = abortReason(signal!, "gh");
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      forceKillTimer.unref?.();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (cancelled) {
        rejectP(cancelled);
        return;
      }
      if (code !== 0) {
        rejectP(new Error(`gh ${args.join(" ")} exited ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        resolveP(stdout.trim() ? (JSON.parse(stdout) as T) : (undefined as unknown as T));
      } catch (e) {
        rejectP(new Error(`gh ${args.join(" ")} returned non-JSON: ${(e as Error).message}`));
      }
    });
    child.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      rejectP(cancelled ?? error);
    });
  });
}

function ghText(args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    if (signal?.aborted) {
      rejectP(abortReason(signal, "gh"));
      return;
    }
    if (args.length === 0 || !ALLOWED_SUBCOMMANDS.has(args[0]!)) {
      rejectP(new Error(`gh subcommand not allowed: ${args[0]}`));
      return;
    }
    if (args[0] === "pr" && args[1] && !ALLOWED_PR_VERBS.has(args[1])) {
      rejectP(new Error(`gh pr verb not allowed: ${args[1]}`));
      return;
    }
    const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let cancelled: Error | null = null;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      cancelled = abortReason(signal!, "gh");
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      forceKillTimer.unref?.();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (cancelled) {
        rejectP(cancelled);
        return;
      }
      if (code !== 0) {
        rejectP(new Error(`gh ${args.join(" ")} exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolveP(stdout);
    });
    child.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      rejectP(cancelled ?? error);
    });
  });
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
