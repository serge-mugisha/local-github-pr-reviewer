/**
 * Canonical catalog of review categories and strictness levels. This is the
 * single source of truth: the prompt builder reads `fragment`/`framing`, the
 * API exposes `label`/`description` to the UI. Add a category here and it
 * flows to both the prompt and the checkbox list automatically.
 */

export interface CategoryDef {
  key: string;
  label: string;
  description: string;
  defaultOn: boolean;
  /** The "flag this" bullet injected into the prompt when enabled. */
  fragment: string;
  /**
   * DO-NOT lines that should be REMOVED from the suppression list when this
   * category is enabled (i.e. enabling the category un-bans these comments).
   */
  unbans?: string[];
}

export interface StrictnessDef {
  key: string;
  label: string;
  description: string;
  framing: string;
}

export const CATEGORIES: CategoryDef[] = [
  {
    key: "bugs",
    label: "Bugs",
    description: "Wrong behavior, crashes, unhandled real cases.",
    defaultOn: true,
    fragment:
      "**Bugs**: the code will produce wrong behavior, crash, or fail to handle a real (not hypothetical) case. Include enough specifics that the author can verify the bug exists.",
  },
  {
    key: "regressions",
    label: "Regressions",
    description: "Breaks behavior that previously worked or weakens a guarantee.",
    defaultOn: true,
    fragment:
      "**Regressions**: this change breaks behavior that previously worked, or removes/weakens an existing guarantee (auth, validation, error handling, contract with callers, test coverage of a real risk).",
  },
  {
    key: "security",
    label: "Security",
    description: "Secrets, injection, authz/authn, unsafe deserialization, races.",
    defaultOn: true,
    fragment:
      "**Security / data-integrity issues**: secrets, injection, missing authz/authn checks, unsafe deserialization, race conditions on shared state, broken transaction boundaries, etc.",
  },
  {
    key: "bad_patterns",
    label: "Harmful patterns",
    description:
      "Approaches that will actively cause pain (hot-path quadratics, swallowed errors).",
    defaultOn: true,
    fragment:
      '**Genuinely harmful patterns** (not merely "could be cleaner"): an approach that will actively cause pain — quadratic loops on hot paths, blocking I/O in the wrong place, swallowed exceptions that hide real failures, a design that already shows it cannot scale.',
  },
  {
    key: "duplication",
    label: "Duplication",
    description: "Non-trivial logic copied such that future changes drift out of sync.",
    defaultOn: true,
    fragment:
      "**Code duplication** that materially raises maintenance cost: the same non-trivial logic copied across files such that future changes will go out of sync. Trivial near-duplicates are NOT comment-worthy.",
  },
  {
    key: "repo_rules",
    label: "Deviation from rules",
    description: "Violations of the global / repo / per-PR reviewer rules below.",
    defaultOn: true,
    fragment:
      "**Violations of the reviewer rules below** (global, repo, and per-PR rules). Treat those as the author's explicit asks — always flag them.",
  },
  {
    key: "code_quality",
    label: "Code quality",
    description: "Maintainability, clarity, and structure problems worth raising.",
    defaultOn: false,
    fragment:
      "**Code quality**: maintainability and clarity problems a teammate would reasonably raise — confusing control flow, leaky abstractions, dead code, misleading names on public surfaces. Skip pure taste.",
    unbans: ['- "Could be more elegant", "consider extracting", "this might be cleaner as".'],
  },
  {
    key: "nits",
    label: "NITs / style",
    description: "Style, naming, formatting, small cleanups. Off by default.",
    defaultOn: false,
    fragment:
      '**Nitpicks**: style, naming, formatting, readability, and minor cleanups. The author has explicitly opted into these — surface them but keep each concise and mark severity "nit".',
    unbans: [
      "- Style, formatting, naming preferences, import order, whitespace.",
      '- "Could be more elegant", "consider extracting", "this might be cleaner as".',
    ],
  },
  {
    key: "tests",
    label: "Test coverage",
    description: "Meaningful logic changed without tests where a regression could slip.",
    defaultOn: false,
    fragment:
      "**Test coverage gaps**: meaningful logic added or changed without corresponding test coverage, where a regression would plausibly go uncaught.",
    unbans: ["- Missing tests for trivial code, missing docstrings, missing comments."],
  },
  {
    key: "docs",
    label: "Docs / comments",
    description: "Public APIs or non-obvious behavior changed without doc updates.",
    defaultOn: false,
    fragment:
      "**Documentation gaps**: a public API, exported symbol, or non-obvious behavior changed without updating the relevant docs or comments.",
    unbans: ["- Missing tests for trivial code, missing docstrings, missing comments."],
  },
  {
    key: "accessibility",
    label: "Accessibility",
    description: "Web/UI: labels, alt text, keyboard, contrast, ARIA, semantics.",
    defaultOn: false,
    fragment:
      "**Accessibility issues** (web/UI changes): missing labels or alt text, keyboard traps, poor contrast, ARIA misuse, or non-semantic markup used for interactive elements.",
  },
];

export const STRICTNESS: StrictnessDef[] = [
  {
    key: "minimal",
    label: "Minimal",
    description: "Only issues that will definitely break something. Silence when in doubt.",
    framing:
      "Be extremely conservative. Comment ONLY on issues you are confident will break something real if merged. When in doubt, stay silent. The overwhelming majority of PRs should receive ZERO comments.",
  },
  {
    key: "balanced",
    label: "Balanced",
    description: "Default. Catch what the author would thank you for; skip the rest.",
    framing:
      'Default to saying NOTHING. Code is allowed to be imperfect. Your job is NOT to make this PR "better" — it\'s to catch things the author would genuinely thank you for catching. Most well-formed PRs should receive ZERO comments. An empty comments array is a valid, common, often correct result.',
  },
  {
    key: "thorough",
    label: "Thorough",
    description: "Lean toward surfacing well-founded concerns, not just blockers.",
    framing:
      "Lean toward surfacing issues you are reasonably confident about, even when they are not strictly merge-blocking. Stay within the enabled categories and still skip pure taste, but do not stay silent on a concern you could defend to the author.",
  },
  {
    key: "pedantic",
    label: "Pedantic",
    description: "Comprehensive pass — surface every defensible issue in scope.",
    framing:
      "Be comprehensive. Surface every issue in the enabled categories that you can defend, including smaller ones. The author has explicitly asked for a detailed, exhaustive pass.",
  },
];

export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);
export const STRICTNESS_KEYS = STRICTNESS.map((s) => s.key);
export const DEFAULT_CATEGORIES = CATEGORIES.filter((c) => c.defaultOn).map((c) => c.key);
export const DEFAULT_STRICTNESS = "balanced";

export function getCategory(key: string): CategoryDef | undefined {
  return CATEGORIES.find((c) => c.key === key);
}

export function getStrictness(key: string): StrictnessDef {
  return (
    STRICTNESS.find((s) => s.key === key) ?? STRICTNESS.find((s) => s.key === DEFAULT_STRICTNESS)!
  );
}

/** Shape exposed to the web UI (no prompt internals). */
export function catalogForClient(): {
  categories: { key: string; label: string; description: string; defaultOn: boolean }[];
  strictness: { key: string; label: string; description: string }[];
} {
  return {
    categories: CATEGORIES.map(({ key, label, description, defaultOn }) => ({
      key,
      label,
      description,
      defaultOn,
    })),
    strictness: STRICTNESS.map(({ key, label, description }) => ({ key, label, description })),
  };
}
