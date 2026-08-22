import type { PRListItem, Repo } from "./api.js";
import type { PrSortMode, RepoSortMode } from "./prefs.js";

export interface RepoPR extends PRListItem {
  repo: Repo;
}

export function normalizeRepoOrder(repos: Repo[], savedOrder: number[]): number[] {
  const validIds = new Set(repos.map((repo) => repo.id));
  return [
    ...savedOrder.filter((id, index) => validIds.has(id) && savedOrder.indexOf(id) === index),
    ...repos.map((repo) => repo.id).filter((id) => !savedOrder.includes(id)),
  ];
}

export function moveRepo(order: number[], repoId: number, targetIndex: number): number[] {
  const fromIndex = order.indexOf(repoId);
  if (fromIndex < 0) return order;
  const next = [...order];
  next.splice(fromIndex, 1);
  next.splice(Math.max(0, Math.min(targetIndex, next.length)), 0, repoId);
  return next;
}

function newestPrTime(repoId: number, prs: Record<number, PRListItem[]>): number {
  return Math.max(0, ...(prs[repoId] ?? []).map((pr) => Date.parse(pr.updatedAt) || 0));
}

export function sortRepos(
  repos: Repo[],
  prs: Record<number, PRListItem[]>,
  mode: RepoSortMode,
  manualOrder: number[],
): Repo[] {
  const orderIndex = new Map(manualOrder.map((id, index) => [id, index]));
  return [...repos].sort((a, b) => {
    if (mode === "name") {
      return `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`);
    }
    if (mode === "recent") {
      const byTime = newestPrTime(b.id, prs) - newestPrTime(a.id, prs);
      if (byTime !== 0) return byTime;
      return `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`);
    }
    return (
      (orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
      (orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER)
    );
  });
}

export function flattenPrs(repos: Repo[], prs: Record<number, PRListItem[]>): RepoPR[] {
  return repos.flatMap((repo) => (prs[repo.id] ?? []).map((pr) => ({ ...pr, repo })));
}

export function filterAndSortPrs(
  prs: RepoPR[],
  sortMode: PrSortMode,
  viewerLogin: string | null,
  ownedByMeOnly: boolean,
  reviewRequestedOnly: boolean,
): RepoPR[] {
  const login = viewerLogin?.toLocaleLowerCase() ?? null;
  const filterEnabled = ownedByMeOnly || reviewRequestedOnly;
  const filtered = !filterEnabled
    ? prs
    : login === null
      ? []
      : prs.filter(
          (pr) =>
            (ownedByMeOnly && pr.author?.toLocaleLowerCase() === login) ||
            (reviewRequestedOnly &&
              (pr.requestedReviewers ?? []).some(
                (reviewer) => reviewer.toLocaleLowerCase() === login,
              )),
        );
  const direction = sortMode === "newest" ? -1 : 1;
  return [...filtered].sort((a, b) => {
    const aCreated = Date.parse(a.createdAt || a.updatedAt) || 0;
    const bCreated = Date.parse(b.createdAt || b.updatedAt) || 0;
    return direction * (aCreated - bCreated || a.id - b.id);
  });
}
