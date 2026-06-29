import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const RepoSchema = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
  localPath: z.string().min(1),
});

const ProviderSchema = z.preprocess(
  (value) => (value === "gemini" || value === "agy" ? "antigravity" : value),
  z.enum(["claude", "antigravity", "codex"]).default("claude"),
);

// Antigravity authenticates via the local `agy` CLI/app state. `sandbox` is
// opt-in because the CLI's terminal restrictions can prevent repo inspection.
const AntigravitySchema = z
  .object({
    model: z.string().min(1).optional(),
    sandbox: z.boolean().optional(),
    printTimeout: z.string().min(1).optional(),
  })
  .optional();

// Codex authenticates via `codex login` / OPENAI_API_KEY (no key needed here).
// `sandbox` defaults to read-only — enough to investigate the diff.
const CodexSchema = z
  .object({
    model: z.string().min(1).optional(),
    sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
  })
  .optional();

const ConfigSchema = z.object({
  provider: ProviderSchema,
  port: z.number().int().positive().default(47823),
  host: z.string().default("127.0.0.1"),
  repos: z.array(RepoSchema).default([]),
  antigravity: AntigravitySchema,
  codex: CodexSchema,
});

export type RepoConfig = z.infer<typeof RepoSchema>;
export type AppConfig = z.infer<typeof ConfigSchema>;

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../../..");
const CONFIG_PATH = resolve(PROJECT_ROOT, "config.json");
const EXAMPLE_PATH = resolve(PROJECT_ROOT, "config.example.json");

export function loadConfig(): AppConfig {
  if (existsSync(CONFIG_PATH)) {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return ConfigSchema.parse(raw);
  }
  // No real config yet — boot with empty repos so the UI shows the setup
  // hint instead of importing the example fixtures.
  if (existsSync(EXAMPLE_PATH)) {
    const raw = JSON.parse(readFileSync(EXAMPLE_PATH, "utf8"));
    const parsed = ConfigSchema.parse(raw);
    return { ...parsed, repos: [] };
  }
  return ConfigSchema.parse({});
}

export function configPath(): string {
  return CONFIG_PATH;
}

export function dataDir(): string {
  return resolve(PROJECT_ROOT, "data");
}

/** Read the on-disk config (or a sensible default if missing). Does NOT
 *  apply the empty-repos override that loadConfig() does on first boot. */
function readConfigFile(): AppConfig {
  if (existsSync(CONFIG_PATH)) {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return ConfigSchema.parse(raw);
  }
  return ConfigSchema.parse({});
}

export function addRepoToConfig(repo: RepoConfig): AppConfig {
  const cfg = readConfigFile();
  const filtered = cfg.repos.filter((r) => !(r.owner === repo.owner && r.name === repo.name));
  filtered.push(repo);
  filtered.sort((a, b) => `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`));
  const next: AppConfig = { ...cfg, repos: filtered };
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n");
  return next;
}

export function removeRepoFromConfig(owner: string, name: string): AppConfig {
  const cfg = readConfigFile();
  const next: AppConfig = {
    ...cfg,
    repos: cfg.repos.filter((r) => !(r.owner === owner && r.name === name)),
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n");
  return next;
}
