import { describe, it, expect } from "vitest";
import { sortFiles, statsForThreads } from "./fileSort.js";
import type { Thread } from "./api.js";

function t(
  partial: Partial<Thread> & { severity?: Thread["severity"]; status?: Thread["status"] },
): Thread {
  return {
    id: Math.random(),
    filePath: "x",
    line: 1,
    side: "RIGHT",
    severity: null,
    status: "open",
    stale: false,
    firstSeenSha: "x",
    lastSeenSha: "x",
    comments: [],
    ...partial,
  };
}

describe("statsForThreads", () => {
  it("counts open vs resolved and tracks the most critical open severity", () => {
    const s = statsForThreads([
      t({ status: "open", severity: "concern" }),
      t({ status: "open", severity: "blocker" }),
      t({ status: "resolved", severity: "concern" }),
    ]);
    expect(s.openCount).toBe(2);
    expect(s.resolvedCount).toBe(1);
    expect(s.topOpenSeverityRank).toBe(0); // blocker
  });

  it("ignores severity of resolved threads when picking top open severity", () => {
    const s = statsForThreads([
      t({ status: "resolved", severity: "blocker" }),
      t({ status: "open", severity: "nit" }),
    ]);
    expect(s.topOpenSeverityRank).toBe(2); // nit
  });
});

describe("sortFiles", () => {
  it("puts files with open threads first, then resolved-only, then untouched", () => {
    const files = [{ path: "untouched.ts" }, { path: "resolved-only.ts" }, { path: "open.ts" }];
    const threads = new Map<string, Thread[]>([
      ["resolved-only.ts", [t({ status: "resolved", severity: "concern" })]],
      ["open.ts", [t({ status: "open", severity: "concern" })]],
    ]);
    const sorted = sortFiles(files, threads);
    expect(sorted.map((f) => f.path)).toEqual(["open.ts", "resolved-only.ts", "untouched.ts"]);
  });

  it("orders open-threaded files by most-critical severity", () => {
    const files = [{ path: "b-nit.ts" }, { path: "a-blocker.ts" }, { path: "c-concern.ts" }];
    const threads = new Map<string, Thread[]>([
      ["b-nit.ts", [t({ status: "open", severity: "nit" })]],
      ["a-blocker.ts", [t({ status: "open", severity: "blocker" })]],
      ["c-concern.ts", [t({ status: "open", severity: "concern" })]],
    ]);
    expect(sortFiles(files, threads).map((f) => f.path)).toEqual([
      "a-blocker.ts",
      "c-concern.ts",
      "b-nit.ts",
    ]);
  });

  it("falls back to alphabetical when severity ties", () => {
    const files = [{ path: "z.ts" }, { path: "a.ts" }];
    const threads = new Map<string, Thread[]>([
      ["z.ts", [t({ status: "open", severity: "concern" })]],
      ["a.ts", [t({ status: "open", severity: "concern" })]],
    ]);
    expect(sortFiles(files, threads).map((f) => f.path)).toEqual(["a.ts", "z.ts"]);
  });

  it("does not mutate the input", () => {
    const files = [{ path: "b.ts" }, { path: "a.ts" }];
    const copy = [...files];
    sortFiles(files, new Map());
    expect(files).toEqual(copy);
  });
});
