import { describe, expect, it } from "vitest";
import type { PrListItem, RepoRow } from "@reviewer/server/api";
import { collectViewerPrs } from "./prDiscovery.js";

const repos = [
  { id: 1, owner: "org", name: "one", local_path: "/one" },
  { id: 2, owner: "org", name: "two", local_path: "/two" },
] as RepoRow[];

function pr(
  id: number,
  author: string,
  requestedReviewers: string[],
  createdAt: string,
  updatedAt = createdAt,
): PrListItem {
  return {
    id,
    number: id,
    title: `PR ${id}`,
    state: "OPEN",
    headRef: "feature",
    baseRef: "main",
    url: `https://example.com/${id}`,
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

const prsByRepo = new Map([
  [1, [pr(1, "Viewer", [], "2026-01-01T00:00:00Z")]],
  [
    2,
    [
      pr(2, "someone", ["viewer"], "2026-01-02T00:00:00Z"),
      pr(3, "someone", [], "2026-01-03T00:00:00Z", "2026-02-01T00:00:00Z"),
    ],
  ],
]);

describe("collectViewerPrs", () => {
  it("returns authored PRs with repository and involvement context", () => {
    const result = collectViewerPrs({
      repos,
      getPrs: (repoId) => prsByRepo.get(repoId) ?? [],
      viewerLogin: "viewer",
      relationship: "authored",
      sort: "oldest",
    });

    expect(result.totalMatching).toBe(1);
    expect(result.prs[0]).toMatchObject({
      id: 1,
      prId: 1,
      repo: { id: 1, owner: "org", name: "one", localPath: "/one" },
      authoredByViewer: true,
      reviewRequestedFromViewer: false,
    });
  });

  it("supports review-requested and combined queues with sorting and limits", () => {
    const reviewRequested = collectViewerPrs({
      repos,
      getPrs: (repoId) => prsByRepo.get(repoId) ?? [],
      viewerLogin: "VIEWER",
      relationship: "review_requested",
      sort: "oldest",
    });
    expect(reviewRequested.prs.map((item) => item.id)).toEqual([2]);

    const combined = collectViewerPrs({
      repos,
      getPrs: (repoId) => prsByRepo.get(repoId) ?? [],
      viewerLogin: "viewer",
      relationship: "authored_or_review_requested",
      sort: "newest",
      limit: 1,
    });
    expect(combined).toMatchObject({ totalMatching: 2, prs: [{ id: 2 }] });
  });
});
