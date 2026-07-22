import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  spawnCli: vi.fn(),
  commandExists: vi.fn(),
  loadConfig: vi.fn(),
}));

vi.mock("./spawn.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./spawn.js")>()),
  spawnCli: mocks.spawnCli,
  commandExists: mocks.commandExists,
}));

vi.mock("../config.js", () => ({ loadConfig: mocks.loadConfig }));

import { codexProvider } from "./codex.js";

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

describe("codexProvider failures", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.loadConfig.mockReturnValue({ codex: undefined });
  });

  it("retains the original auth error before suggesting a fix", async () => {
    const cliError = "401 Unauthorized: run `codex login` to continue";
    mocks.spawnCli.mockResolvedValue({
      exitCode: 1,
      stderr: cliError,
      stdout: "",
      combinedOutput: cliError,
    });

    await expect(codexProvider.review(reviewContext())).rejects.toThrow(
      `codex exited 1\n\n${cliError}\n\nCodex authentication failed.`,
    );
  });
});
