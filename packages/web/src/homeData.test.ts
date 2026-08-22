import { describe, expect, it } from "vitest";
import type { PRListItem, Repo } from "./api.js";
import {
  filterAndSortPrs,
  flattenPrs,
  moveRepo,
  normalizeRepoOrder,
  sortRepos,
} from "./homeData.js";

const repos = [
  { id: 1, owner: "z", name: "zeta" },
  { id: 2, owner: "a", name: "alpha" },
  { id: 3, owner: "m", name: "middle" },
] as Repo[];

function pr(
  id: number,
  createdAt: string,
  updatedAt: string,
  author = "someone",
  requestedReviewers: string[] = [],
): PRListItem {
  return {
    id,
    number: id,
    title: `PR ${id}`,
    state: "OPEN",
    headRef: "feature",
    baseRef: "main",
    url: "https://example.com",
    author,
    assignees: [],
    requestedReviewers,
    createdAt,
    updatedAt,
    hasReview: false,
    reviewStatus: null,
    openThreads: 0,
  };
}

describe("repository ordering", () => {
  it("keeps saved repositories, drops stale ids, and appends new repositories", () => {
    expect(normalizeRepoOrder(repos, [2, 99, 1])).toEqual([2, 1, 3]);
  });

  it("supports moving and alternate sorts without changing manual order", () => {
    const manual = moveRepo([1, 2, 3], 3, 0);
    expect(manual).toEqual([3, 1, 2]);
    expect(sortRepos(repos, {}, "manual", manual).map((repo) => repo.id)).toEqual([3, 1, 2]);
    expect(sortRepos(repos, {}, "name", manual).map((repo) => repo.id)).toEqual([2, 3, 1]);
  });

  it("sorts repositories by their most recently updated PR", () => {
    const prs = {
      1: [pr(1, "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z")],
      2: [pr(2, "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z")],
    };
    expect(sortRepos(repos, prs, "recent", [1, 2, 3]).map((repo) => repo.id)).toEqual([2, 1, 3]);
  });
});

describe("unified PR list", () => {
  it("keeps owned and review-requested filters independent and combines them with OR", () => {
    const prs = {
      1: [pr(1, "2026-01-01T00:00:00Z", "2026-01-03T00:00:00Z", "Viewer")],
      2: [pr(2, "2026-01-02T00:00:00Z", "2026-01-02T00:00:00Z", "other", ["viewer"])],
      3: [pr(3, "2026-01-03T00:00:00Z", "2026-01-01T00:00:00Z")],
    };
    const all = flattenPrs(repos, prs);
    expect(filterAndSortPrs(all, "newest", "viewer", true, false).map((item) => item.id)).toEqual([
      1,
    ]);
    expect(filterAndSortPrs(all, "newest", "viewer", false, true).map((item) => item.id)).toEqual([
      2,
    ]);
    expect(filterAndSortPrs(all, "newest", "viewer", true, true).map((item) => item.id)).toEqual([
      2, 1,
    ]);
    expect(filterAndSortPrs(all, "oldest", null, false, false).map((item) => item.id)).toEqual([
      1, 2, 3,
    ]);
  });

  it("sorts by creation time and falls back to update time for older API payloads", () => {
    const prs = {
      1: [pr(1, "", "2026-01-03T00:00:00Z")],
      2: [pr(2, "", "2026-01-01T00:00:00Z")],
    };
    const all = flattenPrs(repos, prs);
    expect(filterAndSortPrs(all, "newest", null, false, false).map((item) => item.id)).toEqual([
      1, 2,
    ]);
    expect(filterAndSortPrs(all, "oldest", null, false, false).map((item) => item.id)).toEqual([
      2, 1,
    ]);
  });
});
