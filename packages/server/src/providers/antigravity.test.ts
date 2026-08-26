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

vi.mock("../config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

import { antigravityProvider } from "./antigravity.js";

function reviewContext(): ReviewContext {
  return {
    cwd: "/repo",
    prTitle: "Test PR",
    prBody: "",
    prNumber: 12,
    repoSlug: "owner/repo",
    headSha: "abc123",
    baseSha: "def456",
    diff: "diff --git a/src/a.ts b/src/a.ts\n+const value = 1;\n",
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

describe("antigravityProvider", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.loadConfig.mockReturnValue({
      provider: "antigravity",
      port: 47823,
      host: "127.0.0.1",
      repos: [],
      antigravity: undefined,
      codex: undefined,
    });
  });

  it("checks availability with the agy binary", async () => {
    mocks.commandExists.mockResolvedValue(true);

    await expect(antigravityProvider.isAvailable()).resolves.toBe(true);
    expect(mocks.commandExists).toHaveBeenCalledWith("agy");
  });

  it("runs reviews through agy print mode", async () => {
    mocks.spawnCli.mockResolvedValue({
      exitCode: 0,
      stderr: "",
      stdout:
        '```json\n{"summary":"ok","comments":[{"path":"src/a.ts","line":1,"side":"RIGHT","severity":"nit","body":"Check this."}]}\n```',
    });

    const result = await antigravityProvider.review(reviewContext());

    expect(result.summary).toBe("ok");
    expect(result.comments).toHaveLength(1);
    expect(mocks.spawnCli).toHaveBeenCalledTimes(1);
    const call = mocks.spawnCli.mock.calls[0]![0];
    expect(call.cmd).toBe("agy");
    expect(call.cwd).toBe("/repo");
    expect(call.timeoutMs).toBe(15 * 60 * 1000);
    expect(call.args).toEqual([
      "--dangerously-skip-permissions",
      "--print-timeout",
      "15m",
      "--print",
      expect.stringContaining("Test PR"),
    ]);
  });

  it("passes configured model, timeout, and sandbox flags", async () => {
    mocks.loadConfig.mockReturnValue({
      provider: "antigravity",
      port: 47823,
      host: "127.0.0.1",
      repos: [],
      antigravity: {
        model: "Gemini 3.1 Pro (High)",
        printTimeout: "45s",
        sandbox: true,
      },
      codex: undefined,
    });
    mocks.spawnCli.mockResolvedValue({ exitCode: 0, stderr: "", stdout: "done\n" });

    await antigravityProvider.reply({
      cwd: "/repo",
      prTitle: "Test PR",
      prNumber: 12,
      repoSlug: "owner/repo",
      headSha: "abc123",
      threadAnchor: { path: "src/a.ts", line: 1 },
      threadHistory: [{ author: "ai", body: "Review comment" }],
      userMessage: "Why?",
      skills: "",
    });

    expect(mocks.spawnCli.mock.calls[0]![0].args).toEqual([
      "--dangerously-skip-permissions",
      "--print-timeout",
      "45s",
      "--sandbox",
      "--model",
      "Gemini 3.1 Pro (High)",
      "--print",
      expect.stringContaining("Why?"),
    ]);
  });

  it("retains the original auth error before suggesting a fix", async () => {
    const cliError = "OAuth token source expired; login required";
    mocks.spawnCli.mockResolvedValue({
      exitCode: 1,
      stderr: "",
      stdout: cliError,
      combinedOutput: cliError,
    });

    await expect(antigravityProvider.review(reviewContext())).rejects.toThrow(
      `agy exited 1\n\n${cliError}\n\nAntigravity authentication failed.`,
    );
  });

  it("rejects unstructured review output instead of returning a clean review", async () => {
    mocks.spawnCli.mockResolvedValue({
      exitCode: 0,
      stderr: "",
      stdout: "No structured result",
      combinedOutput: "No structured result",
    });

    await expect(antigravityProvider.review(reviewContext())).rejects.toMatchObject({
      name: "ReviewOutputParseError",
      sessionIds: [],
    });
  });
});
