import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeOrphanedDerivedData } from "./xcodeDerivedData.js";

function plist(workspacePath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>LastAccessedDate</key>
	<date>2026-11-03T05:42:52Z</date>
	<key>WorkspacePath</key>
	<string>${workspacePath}</string>
</dict>
</plist>
`;
}

describe("removeOrphanedDerivedData", () => {
  let base: string;
  let derivedData: string;
  let worktrees: string;

  async function derivedDataFor(name: string, workspacePath?: string): Promise<void> {
    const folder = join(derivedData, name);
    await mkdir(join(folder, "Build"), { recursive: true });
    if (workspacePath !== undefined)
      await writeFile(join(folder, "info.plist"), plist(workspacePath));
  }

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "reviewer-derived-data-"));
    derivedData = join(base, "DerivedData");
    worktrees = join(base, "data", "worktrees");
    await mkdir(derivedData, { recursive: true });
    await mkdir(join(worktrees, "repo-1", "pr-2-live"), { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("removes only build data for Reviewer worktrees that no longer exist", async () => {
    await derivedDataFor("app-removed", join(worktrees, "repo-1", "pr-1-gone", "app.xcodeproj"));
    await derivedDataFor("app-live", join(worktrees, "repo-1", "pr-2-live"));
    await derivedDataFor("app-checkout", join(base, "elsewhere", "app.xcodeproj"));
    await derivedDataFor("app-sibling", join(`${worktrees}-other`, "gone", "app.xcodeproj"));
    await derivedDataFor("app-unreadable");
    await mkdir(join(derivedData, "ModuleCache.noindex"));

    await expect(removeOrphanedDerivedData(worktrees, derivedData)).resolves.toBe(1);

    expect((await readdir(derivedData)).sort()).toEqual([
      "ModuleCache.noindex",
      "app-checkout",
      "app-live",
      "app-sibling",
      "app-unreadable",
    ]);
  });

  it("decodes XML entities in the recorded workspace path", async () => {
    await derivedDataFor("app-escaped", join(worktrees, "repo-1", "pr-3-a&amp;b", "app.xcodeproj"));

    await expect(removeOrphanedDerivedData(worktrees, derivedData)).resolves.toBe(1);
    await mkdir(join(worktrees, "repo-1", "pr-4-a&b"), { recursive: true });
    await derivedDataFor("app-escaped-live", join(worktrees, "repo-1", "pr-4-a&amp;b"));

    await expect(removeOrphanedDerivedData(worktrees, derivedData)).resolves.toBe(0);
  });

  it("does nothing when Xcode has no DerivedData directory", async () => {
    await expect(removeOrphanedDerivedData(worktrees, join(base, "missing"))).resolves.toBe(0);
  });
});
