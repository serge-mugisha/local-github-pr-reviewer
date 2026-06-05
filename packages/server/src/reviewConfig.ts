import {
  getDb,
  type PrReviewSettingsRow,
  type GlobalReviewSettingsRow,
  type RulePresetRow,
} from "./db.js";
import {
  CATEGORY_KEYS,
  STRICTNESS_KEYS,
  DEFAULT_CATEGORIES,
  DEFAULT_STRICTNESS,
} from "./reviewCatalog.js";

export interface ReviewConfig {
  categories: string[];
  strictness: string;
  customRules: string;
  pathInclude: string;
  pathExclude: string;
}

export interface GlobalReviewConfig {
  categories: string[];
  strictness: string;
  customRules: string;
}

export interface RulePreset {
  id: number;
  name: string;
  categories: string[];
  strictness: string;
  customRules: string;
}

function now(): string {
  return new Date().toISOString();
}

/** Drop unknown keys and dedupe; preserves catalog ordering. */
function sanitizeCategories(input: unknown): string[] {
  const set = new Set(Array.isArray(input) ? input.map(String) : []);
  return CATEGORY_KEYS.filter((k) => set.has(k));
}

function sanitizeStrictness(input: unknown): string {
  const v = String(input ?? "");
  return STRICTNESS_KEYS.includes(v) ? v : DEFAULT_STRICTNESS;
}

function parseCategories(json: string): string[] {
  try {
    return sanitizeCategories(JSON.parse(json));
  } catch {
    return [...DEFAULT_CATEGORIES];
  }
}

// --- Global settings (singleton, id = 1) ---

export function getGlobalReviewConfig(): GlobalReviewConfig {
  const row = getDb().prepare("SELECT * FROM global_review_settings WHERE id = 1").get() as
    | GlobalReviewSettingsRow
    | undefined;
  if (!row) {
    return {
      categories: [...DEFAULT_CATEGORIES],
      strictness: DEFAULT_STRICTNESS,
      customRules: "",
    };
  }
  return {
    categories: parseCategories(row.categories),
    strictness: sanitizeStrictness(row.strictness),
    customRules: row.custom_rules,
  };
}

export function setGlobalReviewConfig(input: Partial<GlobalReviewConfig>): GlobalReviewConfig {
  const current = getGlobalReviewConfig();
  const next: GlobalReviewConfig = {
    categories: input.categories ? sanitizeCategories(input.categories) : current.categories,
    strictness: input.strictness ? sanitizeStrictness(input.strictness) : current.strictness,
    customRules: input.customRules ?? current.customRules,
  };
  getDb()
    .prepare(
      `
      INSERT INTO global_review_settings (id, categories, strictness, custom_rules, updated_at)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        categories = excluded.categories,
        strictness = excluded.strictness,
        custom_rules = excluded.custom_rules,
        updated_at = excluded.updated_at
    `,
    )
    .run(JSON.stringify(next.categories), next.strictness, next.customRules, now());
  return next;
}

// --- Per-PR settings (absent row inherits global defaults) ---

/** True when the PR has its own saved settings row (not just inherited). */
export function prHasOwnSettings(prId: number): boolean {
  const row = getDb().prepare("SELECT pr_id FROM pr_review_settings WHERE pr_id = ?").get(prId) as
    | { pr_id: number }
    | undefined;
  return !!row;
}

/** Effective per-PR config: the saved row, or global defaults if none. */
export function getPrReviewConfig(prId: number): ReviewConfig {
  const row = getDb().prepare("SELECT * FROM pr_review_settings WHERE pr_id = ?").get(prId) as
    | PrReviewSettingsRow
    | undefined;
  if (!row) {
    const g = getGlobalReviewConfig();
    return {
      categories: g.categories,
      strictness: g.strictness,
      customRules: "",
      pathInclude: "",
      pathExclude: "",
    };
  }
  return {
    categories: parseCategories(row.categories),
    strictness: sanitizeStrictness(row.strictness),
    customRules: row.custom_rules,
    pathInclude: row.path_include,
    pathExclude: row.path_exclude,
  };
}

export function setPrReviewConfig(prId: number, input: Partial<ReviewConfig>): ReviewConfig {
  const current = getPrReviewConfig(prId);
  const next: ReviewConfig = {
    categories: input.categories ? sanitizeCategories(input.categories) : current.categories,
    strictness: input.strictness ? sanitizeStrictness(input.strictness) : current.strictness,
    customRules: input.customRules ?? current.customRules,
    pathInclude: input.pathInclude ?? current.pathInclude,
    pathExclude: input.pathExclude ?? current.pathExclude,
  };
  getDb()
    .prepare(
      `
      INSERT INTO pr_review_settings
        (pr_id, categories, strictness, custom_rules, path_include, path_exclude, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pr_id) DO UPDATE SET
        categories = excluded.categories,
        strictness = excluded.strictness,
        custom_rules = excluded.custom_rules,
        path_include = excluded.path_include,
        path_exclude = excluded.path_exclude,
        updated_at = excluded.updated_at
    `,
    )
    .run(
      prId,
      JSON.stringify(next.categories),
      next.strictness,
      next.customRules,
      next.pathInclude,
      next.pathExclude,
      now(),
    );
  return next;
}

export function resetPrReviewConfig(prId: number): ReviewConfig {
  getDb().prepare("DELETE FROM pr_review_settings WHERE pr_id = ?").run(prId);
  return getPrReviewConfig(prId);
}

// --- Presets ---

function rowToPreset(row: RulePresetRow): RulePreset {
  return {
    id: row.id,
    name: row.name,
    categories: parseCategories(row.categories),
    strictness: sanitizeStrictness(row.strictness),
    customRules: row.custom_rules,
  };
}

export function listPresets(): RulePreset[] {
  const rows = getDb()
    .prepare("SELECT * FROM rule_presets ORDER BY name COLLATE NOCASE")
    .all() as RulePresetRow[];
  return rows.map(rowToPreset);
}

export function createPreset(input: {
  name: string;
  categories: string[];
  strictness: string;
  customRules: string;
}): RulePreset {
  const id = Number(
    getDb()
      .prepare(
        `
        INSERT INTO rule_presets (name, categories, strictness, custom_rules, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        input.name.trim(),
        JSON.stringify(sanitizeCategories(input.categories)),
        sanitizeStrictness(input.strictness),
        input.customRules,
        now(),
        now(),
      ).lastInsertRowid,
  );
  return rowToPreset(
    getDb().prepare("SELECT * FROM rule_presets WHERE id = ?").get(id) as RulePresetRow,
  );
}

export function updatePreset(
  id: number,
  input: { name?: string; categories?: string[]; strictness?: string; customRules?: string },
): RulePreset {
  const existing = getDb().prepare("SELECT * FROM rule_presets WHERE id = ?").get(id) as
    | RulePresetRow
    | undefined;
  if (!existing) throw new Error(`preset ${id} not found`);
  const current = rowToPreset(existing);
  getDb()
    .prepare(
      `
      UPDATE rule_presets SET name = ?, categories = ?, strictness = ?, custom_rules = ?, updated_at = ?
      WHERE id = ?
    `,
    )
    .run(
      (input.name ?? current.name).trim(),
      JSON.stringify(input.categories ? sanitizeCategories(input.categories) : current.categories),
      input.strictness ? sanitizeStrictness(input.strictness) : current.strictness,
      input.customRules ?? current.customRules,
      now(),
      id,
    );
  return rowToPreset(
    getDb().prepare("SELECT * FROM rule_presets WHERE id = ?").get(id) as RulePresetRow,
  );
}

export function deletePreset(id: number): void {
  getDb().prepare("DELETE FROM rule_presets WHERE id = ?").run(id);
}
