import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeReviewerProvider,
  resolveReviewerProvider,
  selectReviewerProvider,
  setPrReviewerProvider,
  setRepoReviewerProvider,
} from "./reviewerProvider.js";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  run: vi.fn(),
}));

vi.mock("./db.js", () => ({
  getDb: () => ({ prepare: mocks.prepare }),
}));

vi.mock("./settings.js", () => ({
  getSettings: () => ({ provider: "claude", port: 47823, host: "127.0.0.1" }),
}));

beforeEach(() => {
  mocks.prepare.mockReset();
  mocks.run.mockReset();
  mocks.prepare.mockReturnValue({ run: mocks.run });
});

describe("selectReviewerProvider", () => {
  it("uses the global provider when no narrower override exists", () => {
    expect(selectReviewerProvider("claude", null, null)).toEqual({
      provider: "claude",
      source: "global",
    });
  });

  it("uses the repository provider ahead of the global provider", () => {
    expect(selectReviewerProvider("claude", "codex", null)).toEqual({
      provider: "codex",
      source: "repo",
    });
  });

  it("uses the PR provider ahead of repository and global providers", () => {
    expect(selectReviewerProvider("claude", "codex", "antigravity")).toEqual({
      provider: "antigravity",
      source: "pr",
    });
  });

  it("resolves persisted row overrides against the current global setting", () => {
    const repo = { reviewer_provider: "codex" } as Parameters<typeof resolveReviewerProvider>[0];
    const pr = { reviewer_provider: null } as NonNullable<
      Parameters<typeof resolveReviewerProvider>[1]
    >;

    expect(resolveReviewerProvider(repo, pr)).toEqual({ provider: "codex", source: "repo" });
    expect(describeReviewerProvider(repo, pr)).toEqual({
      override: null,
      repoOverride: "codex",
      global: "claude",
      provider: "codex",
      source: "repo",
    });
  });

  it("persists and clears repository and PR overrides", () => {
    setRepoReviewerProvider(4, "codex");
    expect(mocks.prepare).toHaveBeenNthCalledWith(
      1,
      "UPDATE repos SET reviewer_provider = ? WHERE id = ?",
    );
    expect(mocks.run).toHaveBeenNthCalledWith(1, "codex", 4);

    setPrReviewerProvider(9, null);
    expect(mocks.prepare).toHaveBeenNthCalledWith(
      2,
      "UPDATE prs SET reviewer_provider = ? WHERE id = ?",
    );
    expect(mocks.run).toHaveBeenNthCalledWith(2, null, 9);
  });
});
