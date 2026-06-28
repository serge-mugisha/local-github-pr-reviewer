import { EventEmitter } from "node:events";
import { describe, expect, it, vi, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { pickFolder } from "./folderPicker.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

function mockSpawnResult({
  code,
  stdout = "",
  stderr = "",
}: {
  code: number;
  stdout?: string;
  stderr?: string;
}) {
  vi.mocked(spawn).mockImplementationOnce(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      child.emit("close", code);
    });
    return child as ReturnType<typeof spawn>;
  });
}

afterEach(() => {
  setPlatform(originalPlatform);
  vi.resetAllMocks();
});

describe("pickFolder", () => {
  it("treats a Linux dialog exit 1 with no output as cancel", async () => {
    setPlatform("linux");
    mockSpawnResult({ code: 1 });

    await expect(pickFolder()).resolves.toBeNull();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      "zenity",
      ["--file-selection", "--directory", "--title=Select a local Git repository"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });
});
