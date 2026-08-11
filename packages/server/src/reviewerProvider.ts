import { getDb, type PrRow, type RepoRow } from "./db.js";
import { getSettings } from "./settings.js";

export type ReviewerProviderSource = "pr" | "repo" | "global";

export interface ReviewerProviderSelection {
  provider: string;
  source: ReviewerProviderSource;
}

export interface ReviewerProviderDescription extends ReviewerProviderSelection {
  override: string | null;
  repoOverride?: string | null;
  global: string;
}

export function selectReviewerProvider(
  globalProvider: string,
  repoProvider: string | null,
  prProvider: string | null = null,
): ReviewerProviderSelection {
  if (prProvider) return { provider: prProvider, source: "pr" };
  if (repoProvider) return { provider: repoProvider, source: "repo" };
  return { provider: globalProvider, source: "global" };
}

export function resolveReviewerProvider(repo: RepoRow, pr?: PrRow): ReviewerProviderSelection {
  return selectReviewerProvider(
    getSettings().provider,
    repo.reviewer_provider,
    pr?.reviewer_provider,
  );
}

export function describeReviewerProvider(repo: RepoRow, pr?: PrRow): ReviewerProviderDescription {
  const global = getSettings().provider;
  return {
    override: pr ? pr.reviewer_provider : repo.reviewer_provider,
    ...(pr ? { repoOverride: repo.reviewer_provider } : {}),
    global,
    ...selectReviewerProvider(global, repo.reviewer_provider, pr?.reviewer_provider),
  };
}

export function setRepoReviewerProvider(repoId: number, provider: string | null): void {
  getDb().prepare("UPDATE repos SET reviewer_provider = ? WHERE id = ?").run(provider, repoId);
}

export function setPrReviewerProvider(prId: number, provider: string | null): void {
  getDb().prepare("UPDATE prs SET reviewer_provider = ? WHERE id = ?").run(provider, prId);
}
