import { describe, expect, it } from "vitest";
import { formatCliFailure, type SpawnResult } from "./spawn.js";

function result(partial: Partial<SpawnResult>): SpawnResult {
  return {
    stdout: "",
    stderr: "",
    combinedOutput: "",
    exitCode: 1,
    ...partial,
  };
}

describe("formatCliFailure", () => {
  it("preserves interleaved stdout and stderr without truncation", () => {
    const output = `stdout detail\n${"x".repeat(700)}\nstderr detail`;

    expect(formatCliFailure("claude", result({ combinedOutput: output }))).toBe(
      `claude exited 1\n\n${output}`,
    );
  });

  it("falls back to the separate streams for legacy results", () => {
    expect(
      formatCliFailure(
        "codex",
        result({ combinedOutput: "", stderr: "stderr detail", stdout: "stdout detail" }),
      ),
    ).toBe("codex exited 1\n\nstderr detail\nstdout detail");
  });

  it("explains when the CLI produced no error output", () => {
    expect(formatCliFailure("agy", result({}), "produced no assistant output")).toBe(
      "agy produced no assistant output without producing error output.",
    );
  });
});
