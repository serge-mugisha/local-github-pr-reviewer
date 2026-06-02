import type { Thread } from "./api.js";

/** Lower number = more critical. Threads without severity fall back to "concern". */
export const SEVERITY_RANK: Record<string, number> = {
  blocker: 0,
  concern: 1,
  nit: 2,
  praise: 3,
};

export const NO_SEVERITY_RANK = 99;

function rankForSeverity(severity: string | null | undefined): number {
  if (!severity) return SEVERITY_RANK.concern!;
  return SEVERITY_RANK[severity] ?? SEVERITY_RANK.concern!;
}

export interface FileStats {
  openCount: number;
  resolvedCount: number;
  /** Lowest severity rank among open threads (most critical). */
  topOpenSeverityRank: number;
}

export function statsForThreads(threads: Thread[]): FileStats {
  let openCount = 0;
  let resolvedCount = 0;
  let topOpenSeverityRank = NO_SEVERITY_RANK;
  for (const t of threads) {
    if (t.status === "open") {
      openCount++;
      const r = rankForSeverity(t.severity);
      if (r < topOpenSeverityRank) topOpenSeverityRank = r;
    } else if (t.status === "resolved") {
      resolvedCount++;
    }
  }
  return { openCount, resolvedCount, topOpenSeverityRank };
}

/**
 * Sort files for the PR view:
 *   1. Files with OPEN threads first, ordered by most-critical severity.
 *   2. Then files whose threads are all resolved.
 *   3. Then files with no AI threads at all.
 * Ties within a group fall back to alphabetical by path.
 */
export function sortFiles<F extends { path: string }>(
  files: F[],
  threadsByFile: Map<string, Thread[]>,
): F[] {
  const groupRank = (f: F): number => {
    const s = statsForThreads(threadsByFile.get(f.path) ?? []);
    if (s.openCount > 0) return 0;
    if (s.resolvedCount > 0) return 1;
    return 2;
  };
  return [...files].sort((a, b) => {
    const ga = groupRank(a);
    const gb = groupRank(b);
    if (ga !== gb) return ga - gb;
    const sa = statsForThreads(threadsByFile.get(a.path) ?? []);
    const sb = statsForThreads(threadsByFile.get(b.path) ?? []);
    if (sa.topOpenSeverityRank !== sb.topOpenSeverityRank) {
      return sa.topOpenSeverityRank - sb.topOpenSeverityRank;
    }
    return a.path.localeCompare(b.path);
  });
}
