import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoRow } from "./db.js";
import { refreshOpenPRs } from "./prs.js";

interface TestPr {
  id: number;
  repo_id: number;
  number: number;
  title: string;
  head_ref: string;
  base_ref: string;
  state: string;
  url: string;
  author: string | null;
  updated_at: string;
  reviewer_provider: string | null;
}

const mocks = vi.hoisted(() => ({
  listOpenPRs: vi.fn(),
  purgeSessionsForPrs: vi.fn(),
  prs: [] as TestPr[],
  nextId: 1,
}));

vi.mock("./github.js", () => ({
  listOpenPRs: mocks.listOpenPRs,
}));

vi.mock("./sessions.js", () => ({
  purgeSessionsForPrs: mocks.purgeSessionsForPrs,
}));

vi.mock("./db.js", () => ({
  getDb: () => ({
    prepare: (sql: string) => {
      if (sql.includes("INSERT INTO prs")) {
        return {
          run: (
            repoId: number,
            number: number,
            title: string,
            headRef: string,
            baseRef: string,
            state: string,
            url: string,
            author: string | null,
            updatedAt: string,
          ) => {
            const existing = mocks.prs.find((p) => p.repo_id === repoId && p.number === number);
            if (existing) {
              Object.assign(existing, {
                title,
                head_ref: headRef,
                base_ref: baseRef,
                state,
                url,
                author,
                updated_at: updatedAt,
              });
              return { changes: 1 };
            }
            mocks.prs.push({
              id: mocks.nextId++,
              repo_id: repoId,
              number,
              title,
              head_ref: headRef,
              base_ref: baseRef,
              state,
              url,
              author,
              updated_at: updatedAt,
              reviewer_provider: null,
            });
            return { changes: 1 };
          },
        };
      }
      if (sql.includes("SELECT number FROM prs WHERE repo_id = ?")) {
        return {
          all: (repoId: number) =>
            mocks.prs.filter((p) => p.repo_id === repoId).map((p) => ({ number: p.number })),
        };
      }
      if (sql.includes("SELECT id FROM prs WHERE repo_id = ? AND number IN")) {
        return {
          all: (repoId: number, ...numbers: number[]) =>
            mocks.prs
              .filter((p) => p.repo_id === repoId && numbers.includes(p.number))
              .map((p) => ({ id: p.id })),
        };
      }
      if (sql.includes("DELETE FROM prs WHERE repo_id = ? AND number IN")) {
        return {
          run: (repoId: number, ...numbers: number[]) => {
            const before = mocks.prs.length;
            mocks.prs = mocks.prs.filter(
              (p) => p.repo_id !== repoId || !numbers.includes(p.number),
            );
            return { changes: before - mocks.prs.length };
          },
        };
      }
      if (sql.includes("FROM prs p")) {
        return {
          all: (repoId: number) =>
            mocks.prs
              .filter((p) => p.repo_id === repoId)
              .sort((a, b) => b.number - a.number)
              .map((p) => ({
                id: p.id,
                number: p.number,
                title: p.title,
                state: p.state,
                headRef: p.head_ref,
                baseRef: p.base_ref,
                url: p.url,
                author: p.author,
                updatedAt: p.updated_at,
                hasReview: 0,
                reviewStatus: null,
                openThreads: 0,
              })),
        };
      }
      throw new Error(`Unexpected SQL in test: ${sql}`);
    },
    transaction: (fn: () => void) => fn,
  }),
}));

const repo: RepoRow = {
  id: 1,
  owner: "serge-mugisha",
  name: "buildmate",
  local_path: "/tmp/buildmate",
  reviewer_provider: null,
};

beforeEach(() => {
  mocks.prs = [
    {
      id: 1,
      repo_id: repo.id,
      number: 47,
      title: "Closed PR",
      head_ref: "closed",
      base_ref: "main",
      state: "OPEN",
      url: "https://github.com/serge-mugisha/buildmate/pull/47",
      author: "serge-mugisha",
      updated_at: "2026-01-01T00:00:00Z",
      reviewer_provider: null,
    },
    {
      id: 2,
      repo_id: repo.id,
      number: 48,
      title: "Still open",
      head_ref: "open",
      base_ref: "main",
      state: "OPEN",
      url: "https://github.com/serge-mugisha/buildmate/pull/48",
      author: "serge-mugisha",
      updated_at: "2026-01-02T00:00:00Z",
      reviewer_provider: "codex",
    },
  ];
  mocks.nextId = 3;
  mocks.listOpenPRs.mockReset();
  mocks.purgeSessionsForPrs.mockReset();
});

describe("refreshOpenPRs", () => {
  it("purges cached PRs and their review sessions when they are no longer open", async () => {
    mocks.listOpenPRs.mockResolvedValue([
      {
        number: 48,
        title: "Still open",
        state: "OPEN",
        headRefName: "open",
        baseRefName: "main",
        url: "https://github.com/serge-mugisha/buildmate/pull/48",
        isDraft: false,
        updatedAt: "2026-01-02T00:00:00Z",
        author: { login: "serge-mugisha" },
      },
    ]);

    const refreshed = await refreshOpenPRs(repo);

    expect(refreshed.map((p) => p.number)).toEqual([48]);
    expect(mocks.prs.map((p) => p.number)).toEqual([48]);
    expect(mocks.prs[0]?.reviewer_provider).toBe("codex");
    expect(mocks.purgeSessionsForPrs).toHaveBeenCalledTimes(1);
    expect(mocks.purgeSessionsForPrs).toHaveBeenCalledWith([1]);
  });
});
