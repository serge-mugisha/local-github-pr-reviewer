import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { dataDir } from "./config.js";

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;
  mkdirSync(dataDir(), { recursive: true });
  const db = new Database(resolve(dataDir(), "reviewer.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrateDatabase(db);
  dbInstance = db;
  return db;
}

export function migrateDatabase(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      local_path TEXT NOT NULL,
      reviewer_provider TEXT,
      UNIQUE(owner, name)
    );

    CREATE TABLE IF NOT EXISTS prs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      head_sha TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      head_ref TEXT NOT NULL,
      base_ref TEXT NOT NULL,
      state TEXT NOT NULL,
      url TEXT NOT NULL,
      author TEXT,
      updated_at TEXT NOT NULL,
      reviewer_provider TEXT,
      UNIQUE(repo_id, number)
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id INTEGER NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
      head_sha TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT,
      started_at TEXT NOT NULL,
      heartbeat_at TEXT,
      finished_at TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id INTEGER NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
      file_path TEXT,
      line INTEGER,
      side TEXT,
      severity TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      first_seen_sha TEXT NOT NULL,
      last_seen_sha TEXT NOT NULL,
      stale INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'normal',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skills (
      repo_id INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
      body TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS viewed_files (
      pr_id INTEGER NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (pr_id, file_path)
    );

    -- Per-PR review configuration. Absent row = inherit global defaults.
    CREATE TABLE IF NOT EXISTS pr_review_settings (
      pr_id INTEGER PRIMARY KEY REFERENCES prs(id) ON DELETE CASCADE,
      categories TEXT NOT NULL,
      strictness TEXT NOT NULL DEFAULT 'balanced',
      custom_rules TEXT NOT NULL DEFAULT '',
      path_include TEXT NOT NULL DEFAULT '',
      path_exclude TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    -- Singleton (id = 1): default categories/strictness for new PRs plus
    -- custom rules applied to every review in every repo.
    CREATE TABLE IF NOT EXISTS global_review_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      categories TEXT NOT NULL,
      strictness TEXT NOT NULL DEFAULT 'balanced',
      custom_rules TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    -- Named, reusable bundles of (categories + strictness + custom rules).
    CREATE TABLE IF NOT EXISTS rule_presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      categories TEXT NOT NULL,
      strictness TEXT NOT NULL DEFAULT 'balanced',
      custom_rules TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- AI CLI chat sessions spawned while reviewing/replying on a PR. The
    -- provider CLIs (Claude, Antigravity, Codex) may persist a conversation per invocation in
    -- the user's home dir; we track them here so they can be deleted when the
    -- PR is purged, keeping the user's real coding sessions uncluttered.
    CREATE TABLE IF NOT EXISTS ai_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id INTEGER NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      session_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(pr_id, provider, session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_threads_pr ON threads(pr_id);
    CREATE INDEX IF NOT EXISTS idx_comments_thread ON comments(thread_id);
    CREATE INDEX IF NOT EXISTS idx_prs_repo ON prs(repo_id);
    CREATE INDEX IF NOT EXISTS idx_ai_sessions_pr ON ai_sessions(pr_id);
  `);

  const reviewColumns = db.pragma("table_info(reviews)") as { name: string }[];
  if (!reviewColumns.some((column) => column.name === "heartbeat_at")) {
    db.exec("ALTER TABLE reviews ADD COLUMN heartbeat_at TEXT");
  }

  const repoColumns = db.pragma("table_info(repos)") as { name: string }[];
  if (!repoColumns.some((column) => column.name === "reviewer_provider")) {
    db.exec("ALTER TABLE repos ADD COLUMN reviewer_provider TEXT");
  }

  const prColumns = db.pragma("table_info(prs)") as { name: string }[];
  if (!prColumns.some((column) => column.name === "reviewer_provider")) {
    db.exec("ALTER TABLE prs ADD COLUMN reviewer_provider TEXT");
  }
}

// --- Row types ---

export interface RepoRow {
  id: number;
  owner: string;
  name: string;
  local_path: string;
  reviewer_provider: string | null;
}
export interface PrRow {
  id: number;
  repo_id: number;
  number: number;
  title: string;
  body: string;
  head_sha: string;
  base_sha: string;
  head_ref: string;
  base_ref: string;
  state: string;
  url: string;
  author: string | null;
  updated_at: string;
  reviewer_provider: string | null;
}
export interface ReviewRow {
  id: number;
  pr_id: number;
  head_sha: string;
  provider: string;
  status: string;
  summary: string | null;
  started_at: string;
  heartbeat_at: string | null;
  finished_at: string | null;
  error: string | null;
}
export interface ThreadRow {
  id: number;
  pr_id: number;
  file_path: string | null;
  line: number | null;
  side: string | null;
  severity: string | null;
  status: string;
  first_seen_sha: string;
  last_seen_sha: string;
  stale: number;
  created_at: string;
}
export interface CommentRow {
  id: number;
  thread_id: number;
  author: string;
  body: string;
  head_sha: string;
  kind: string;
  created_at: string;
}
export interface AiSessionRow {
  id: number;
  pr_id: number;
  provider: string;
  session_id: string;
  cwd: string;
  created_at: string;
}
export interface SkillsRow {
  repo_id: number;
  body: string;
  updated_at: string;
}
export interface ViewedFileRow {
  pr_id: number;
  file_path: string;
  head_sha: string;
  updated_at: string;
}
export interface PrReviewSettingsRow {
  pr_id: number;
  categories: string;
  strictness: string;
  custom_rules: string;
  path_include: string;
  path_exclude: string;
  updated_at: string;
}
export interface GlobalReviewSettingsRow {
  id: number;
  categories: string;
  strictness: string;
  custom_rules: string;
  updated_at: string;
}
export interface RulePresetRow {
  id: number;
  name: string;
  categories: string;
  strictness: string;
  custom_rules: string;
  created_at: string;
  updated_at: string;
}

// --- Repo upsert (driven by config.json) ---

export function syncReposFromConfig(
  repos: { owner: string; name: string; localPath: string }[],
): RepoRow[] {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO repos (owner, name, local_path) VALUES (?, ?, ?)
    ON CONFLICT(owner, name) DO UPDATE SET local_path = excluded.local_path
  `);
  for (const r of repos) stmt.run(r.owner, r.name, r.localPath);
  return db.prepare("SELECT * FROM repos ORDER BY owner, name").all() as RepoRow[];
}

export function listRepos(): RepoRow[] {
  return getDb().prepare("SELECT * FROM repos ORDER BY owner, name").all() as RepoRow[];
}

export function getRepo(id: number): RepoRow | undefined {
  return getDb().prepare("SELECT * FROM repos WHERE id = ?").get(id) as RepoRow | undefined;
}

export function findRepoByOwnerName(owner: string, name: string): RepoRow | undefined {
  return getDb().prepare("SELECT * FROM repos WHERE owner = ? AND name = ?").get(owner, name) as
    | RepoRow
    | undefined;
}
