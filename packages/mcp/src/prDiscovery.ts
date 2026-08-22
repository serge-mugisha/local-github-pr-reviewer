import type { PrListItem, RepoRow } from "@reviewer/server/api";

export type ViewerRelationship = "authored" | "review_requested" | "authored_or_review_requested";
export type ViewerPrSort = "oldest" | "newest" | "recently_updated";

export interface ViewerPr extends PrListItem {
  prId: number;
  repo: {
    id: number;
    owner: string;
    name: string;
    localPath: string;
  };
  authoredByViewer: boolean;
  reviewRequestedFromViewer: boolean;
}

export interface CollectViewerPrsOptions {
  repos: RepoRow[];
  getPrs: (repoId: number) => PrListItem[];
  viewerLogin: string;
  relationship: ViewerRelationship;
  sort: ViewerPrSort;
  limit?: number;
}

export function collectViewerPrs(options: CollectViewerPrsOptions): {
  totalMatching: number;
  prs: ViewerPr[];
} {
  const viewer = options.viewerLogin.toLocaleLowerCase();
  const matches = options.repos.flatMap((repo) =>
    options
      .getPrs(repo.id)
      .map((pr): ViewerPr => {
        const authoredByViewer = pr.author?.toLocaleLowerCase() === viewer;
        const reviewRequestedFromViewer = pr.requestedReviewers.some(
          (reviewer) => reviewer.toLocaleLowerCase() === viewer,
        );
        return {
          ...pr,
          prId: pr.id,
          repo: {
            id: repo.id,
            owner: repo.owner,
            name: repo.name,
            localPath: repo.local_path,
          },
          authoredByViewer,
          reviewRequestedFromViewer,
        };
      })
      .filter((pr) => {
        if (options.relationship === "authored") return pr.authoredByViewer;
        if (options.relationship === "review_requested") {
          return pr.reviewRequestedFromViewer;
        }
        return pr.authoredByViewer || pr.reviewRequestedFromViewer;
      }),
  );

  matches.sort((a, b) => {
    if (options.sort === "recently_updated") {
      return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
    }
    const direction = options.sort === "newest" ? -1 : 1;
    const aCreated = Date.parse(a.createdAt || a.updatedAt) || 0;
    const bCreated = Date.parse(b.createdAt || b.updatedAt) || 0;
    return direction * (aCreated - bCreated || a.id - b.id);
  });

  return {
    totalMatching: matches.length,
    prs: options.limit === undefined ? matches : matches.slice(0, options.limit),
  };
}
