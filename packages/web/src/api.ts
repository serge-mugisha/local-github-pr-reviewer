export interface Repo {
  id: number;
  owner: string;
  name: string;
  localPath: string;
  reviewerProvider: ReviewerProviderSelection;
}

export interface PRListItem {
  id: number;
  number: number;
  title: string;
  state: string;
  headRef: string;
  baseRef: string;
  url: string;
  author: string | null;
  updatedAt: string;
  hasReview: boolean;
  openThreads: number;
}

export interface Comment {
  id: number;
  author: "ai" | "user";
  body: string;
  headSha: string;
  kind: string;
  createdAt: string;
}

export interface Thread {
  id: number;
  filePath: string | null;
  line: number | null;
  side: "LEFT" | "RIGHT" | null;
  severity: string | null;
  status: "open" | "resolved";
  stale: boolean;
  firstSeenSha: string;
  lastSeenSha: string;
  comments: Comment[];
}

export interface PR {
  id: number;
  number: number;
  title: string;
  body: string;
  headSha: string;
  baseSha: string;
  headRef: string;
  baseRef: string;
  state: string;
  url: string;
  author: string | null;
  updatedAt: string;
}

export interface LastReview {
  id: number;
  headSha: string;
  provider: string;
  status: string;
  summary: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface SummaryReview {
  id: number;
  headSha: string;
  provider: string;
  summary: string;
  finishedAt: string | null;
}

export interface PRDetail {
  pr: PR;
  repo: { id: number; owner: string; name: string };
  reviewerProvider: ReviewerProviderSelection;
  reviewerProviders: Pick<ProviderStatus, "id" | "displayName">[];
  threads: Thread[];
  viewedFiles: string[];
  lastReview: LastReview | null;
  summaryReview: SummaryReview | null;
}

export interface ReviewerProviderSelection {
  override: string | null;
  repoOverride?: string | null;
  global: string;
  provider: string;
  source: "pr" | "repo" | "global";
}

export interface CategoryDef {
  key: string;
  label: string;
  description: string;
  defaultOn: boolean;
}

export interface StrictnessDef {
  key: string;
  label: string;
  description: string;
}

export interface ReviewCatalog {
  categories: CategoryDef[];
  strictness: StrictnessDef[];
}

export interface GlobalReviewConfig {
  categories: string[];
  strictness: string;
  customRules: string;
}

export interface PrReviewConfig {
  categories: string[];
  strictness: string;
  customRules: string;
  pathInclude: string;
  pathExclude: string;
  customized: boolean;
}

export interface RulePreset {
  id: number;
  name: string;
  categories: string[];
  strictness: string;
  customRules: string;
}

export interface ProviderStatus {
  id: string;
  displayName: string;
  available: boolean;
}

export interface AppStatus {
  providers: ProviderStatus[];
  gh: { ok: boolean; message: string };
  settings: { provider: string; port: number; host: string };
}

async function jsonReq<T>(url: string, init?: RequestInit): Promise<T> {
  // Only set Content-Type when we actually have a body. Fastify rejects
  // bodyless requests that declare application/json as malformed.
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (init?.body !== undefined && headers["Content-Type"] === undefined) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  status: () => jsonReq<AppStatus>("/api/status"),
  repos: () => jsonReq<Repo[]>("/api/repos"),
  pickRepoFolder: () =>
    jsonReq<{ localPath: string | null }>("/api/repos/pick-folder", { method: "POST" }),
  detectRepo: (localPath: string) =>
    jsonReq<{ owner: string; name: string; localPath: string }>("/api/repos/detect", {
      method: "POST",
      body: JSON.stringify({ localPath }),
    }),
  addRepo: (localPath: string) =>
    jsonReq<{ id: number; owner: string; name: string; localPath: string }>("/api/repos", {
      method: "POST",
      body: JSON.stringify({ localPath }),
    }),
  removeRepo: (repoId: number) =>
    jsonReq<{ removed: { owner: string; name: string }; remaining: number }>(
      `/api/repos/${repoId}`,
      { method: "DELETE" },
    ),
  setRepoReviewerProvider: (repoId: number, provider: string | null) =>
    jsonReq<{ reviewerProvider: ReviewerProviderSelection }>(
      `/api/repos/${repoId}/reviewer-provider`,
      { method: "PUT", body: JSON.stringify({ provider }) },
    ),
  prs: (repoId: number) => jsonReq<PRListItem[]>(`/api/repos/${repoId}/prs`),
  refreshPRs: (repoId: number) =>
    jsonReq<PRListItem[]>(`/api/repos/${repoId}/prs/refresh`, { method: "POST" }),
  pr: (prId: number) => jsonReq<PRDetail>(`/api/prs/${prId}`),
  setPrReviewerProvider: (prId: number, provider: string | null) =>
    jsonReq<ReviewerProviderSelection>(`/api/prs/${prId}/reviewer-provider`, {
      method: "PUT",
      body: JSON.stringify({ provider }),
    }),
  reviewStatus: (prId: number) => jsonReq<LastReview | null>(`/api/prs/${prId}/review/status`),
  diff: async (prId: number): Promise<string> => {
    const res = await fetch(`/api/prs/${prId}/diff`);
    if (!res.ok) throw new Error(await res.text());
    return res.text();
  },
  clearReview: (prId: number) =>
    jsonReq<{ threads: number; comments: number; reviews: number }>(`/api/prs/${prId}/review`, {
      method: "DELETE",
    }),
  skills: (repoId: number) => jsonReq<{ body: string }>(`/api/repos/${repoId}/skills`),
  saveSkills: (repoId: number, body: string) =>
    jsonReq<{ body: string }>(`/api/repos/${repoId}/skills`, {
      method: "PUT",
      body: JSON.stringify({ body }),
    }),
  setStatus: (threadId: number, status: "open" | "resolved") =>
    jsonReq<{ ok: true }>(`/api/threads/${threadId}/status`, {
      method: "POST",
      body: JSON.stringify({ status }),
    }),
  setFileViewed: (prId: number, filePath: string, viewed: boolean) =>
    jsonReq<{ viewedFiles: string[] }>(`/api/prs/${prId}/viewed`, {
      method: "POST",
      body: JSON.stringify({ filePath, viewed }),
    }),
  setProvider: (provider: string) =>
    jsonReq<{ provider: string }>(`/api/settings`, {
      method: "PUT",
      body: JSON.stringify({ provider }),
    }),

  reviewCatalog: () => jsonReq<ReviewCatalog>("/api/review-config/catalog"),
  globalReviewConfig: () => jsonReq<GlobalReviewConfig>("/api/review-config/global"),
  saveGlobalReviewConfig: (cfg: Partial<GlobalReviewConfig>) =>
    jsonReq<GlobalReviewConfig>("/api/review-config/global", {
      method: "PUT",
      body: JSON.stringify(cfg),
    }),

  presets: () => jsonReq<RulePreset[]>("/api/review-config/presets"),
  createPreset: (p: Omit<RulePreset, "id">) =>
    jsonReq<RulePreset>("/api/review-config/presets", {
      method: "POST",
      body: JSON.stringify(p),
    }),
  updatePreset: (id: number, p: Partial<Omit<RulePreset, "id">>) =>
    jsonReq<RulePreset>(`/api/review-config/presets/${id}`, {
      method: "PUT",
      body: JSON.stringify(p),
    }),
  deletePreset: (id: number) =>
    jsonReq<{ ok: true }>(`/api/review-config/presets/${id}`, { method: "DELETE" }),

  prReviewConfig: (prId: number) => jsonReq<PrReviewConfig>(`/api/prs/${prId}/review-config`),
  savePrReviewConfig: (prId: number, cfg: Partial<Omit<PrReviewConfig, "customized">>) =>
    jsonReq<PrReviewConfig>(`/api/prs/${prId}/review-config`, {
      method: "PUT",
      body: JSON.stringify(cfg),
    }),
  resetPrReviewConfig: (prId: number) =>
    jsonReq<PrReviewConfig>(`/api/prs/${prId}/review-config`, { method: "DELETE" }),
  previewReviewConfig: (prId: number, cfg: Omit<PrReviewConfig, "customized">) =>
    jsonReq<{ instructions: string }>(`/api/prs/${prId}/review-config/preview`, {
      method: "POST",
      body: JSON.stringify(cfg),
    }),
};

// SSE helper: POST + read SSE stream from the same response.
export interface SseEvent {
  event: string;
  data: unknown;
}

export async function postSse(
  url: string,
  body: unknown,
  onEvent: (evt: SseEvent) => void,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok || !res.body) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const events = buf.split("\n\n");
    buf = events.pop() ?? "";
    for (const block of events) {
      const lines = block.split("\n");
      let ev = "message";
      const dataParts: string[] = [];
      for (const line of lines) {
        if (line.startsWith("event:")) ev = line.slice(6).trim();
        else if (line.startsWith("data:")) dataParts.push(line.slice(5).trim());
      }
      if (dataParts.length === 0) continue;
      try {
        const data = JSON.parse(dataParts.join("\n"));
        onEvent({ event: ev, data });
      } catch {
        onEvent({ event: ev, data: dataParts.join("\n") });
      }
    }
  }
}
