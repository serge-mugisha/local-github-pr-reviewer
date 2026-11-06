import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { access, readdir, readFile, rm } from "node:fs/promises";

export const XCODE_DERIVED_DATA_DIR = join(homedir(), "Library/Developer/Xcode/DerivedData");

const WORKSPACE_PATH = /<key>WorkspacePath<\/key>\s*<string>([^<]*)<\/string>/;
const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

async function workspacePathOf(derivedDataFolder: string): Promise<string | undefined> {
  try {
    const plist = await readFile(join(derivedDataFolder, "info.plist"), "utf8");
    const workspace = WORKSPACE_PATH.exec(plist)?.[1];
    return workspace?.replace(
      /&(amp|lt|gt|quot|apos);/g,
      (entity, name: string) => XML_ENTITIES[name] ?? entity,
    );
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Deletes only folders whose recorded workspace was under `worktreesRoot` and no longer exists. */
export async function removeOrphanedDerivedData(
  worktreesRoot: string,
  derivedDataDir = XCODE_DERIVED_DATA_DIR,
): Promise<number> {
  const root = resolve(worktreesRoot) + sep;
  let entries: Array<{ isDirectory(): boolean; name: string }>;
  try {
    entries = await readdir(derivedDataDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folder = join(derivedDataDir, entry.name);
    const workspace = await workspacePathOf(folder);
    if (!workspace?.startsWith(root) || (await exists(workspace))) continue;
    await rm(folder, { recursive: true, force: true });
    removed++;
  }
  return removed;
}
