import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  spawnCli: vi.fn(),
  commandExists: vi.fn(),
}));

vi.mock("./spawn.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./spawn.js")>()),
  spawnCli: mocks.spawnCli,
  commandExists: mocks.commandExists,
}));

import { claudeProvider } from "./claude.js";

function reviewContext(): ReviewContext {
  return {
    cwd: "/repo",
    prTitle: "Test PR",
    prBody: "",
    prNumber: 1,
    repoSlug: "owner/repo",
    headSha: "abc123",
    baseSha: "def456",
    diff: "+change",
    skills: "",
    config: {
      categories: ["correctness"],
      strictness: "normal",
      globalRules: "",
      repoRules: "",
      perPrRules: "",
      pathInclude: "",
      pathExclude: "",
    },
    existingOpenThreads: [],
  };
}

describe("claudeProvider failures", () => {
  beforeEach(() => vi.resetAllMocks());

  it("reports a full stdout-only CLI failure", async () => {
    const cliError = `Authentication expired\n${"detail".repeat(100)}`;
    mocks.spawnCli.mockResolvedValue({
      exitCode: 1,
      stderr: "",
      stdout: cliError,
      combinedOutput: cliError,
    });

    await expect(claudeProvider.review(reviewContext())).rejects.toThrow(
      `claude exited 1\n\n${cliError}`,
    );
  });
});
