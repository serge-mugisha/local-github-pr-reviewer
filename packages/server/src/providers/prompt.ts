import type { ReviewContext, ReplyContext, RevalidateContext } from "./types.js";
import type { ReviewInstructionConfig } from "./types.js";
import { CATEGORIES, getCategory, getStrictness } from "../reviewCatalog.js";

const PREAMBLE = `
You are a local pull-request reviewer. You have full read access to the working
copy at the current working directory. USE YOUR TOOLS: read changed files in
full, grep for callers, look at tests, run quick commands. Investigate before
commenting.
`.trim();

const BASE_SUPPRESSIONS = [
  "- Style, formatting, naming preferences, import order, whitespace.",
  '- "Could be more elegant", "consider extracting", "this might be cleaner as".',
  "- Missing tests for trivial code, missing docstrings, missing comments.",
  "- Defensive checks for situations that cannot actually occur in this codebase.",
  "- Hypothetical performance concerns that aren't on a hot path.",
  "- Praise or general approval — return an empty array instead.",
  "- Anything you wouldn't bring up if the author were sitting next to you and\n  had ten minutes to merge.",
];

const ANCHOR_INSTRUCTIONS = `
Anchor each comment to a path + line in the NEW file (side="RIGHT") whenever
possible. Use side="LEFT" only for comments about removed lines. If a comment
is repo-wide and not line-specific, omit path and line.
`.trim();

function categoriesBlock(enabled: string[]): string {
  // Preserve catalog order; ignore unknown keys.
  const defs = CATEGORIES.filter((c) => enabled.includes(c.key));
  if (defs.length === 0) {
    return "(no categories selected — only flag violations of the explicit reviewer rules below)";
  }
  return defs.map((d, i) => `${i + 1}. ${d.fragment}`).join("\n");
}

function suppressionsBlock(enabled: string[]): string {
  const unbanned = new Set<string>();
  for (const key of enabled) getCategory(key)?.unbans?.forEach((u) => unbanned.add(u));
  const kept = BASE_SUPPRESSIONS.filter((line) => !unbanned.has(line));
  return kept.join("\n");
}

function severityScale(enabled: string[]): string {
  const nitsOn = enabled.includes("nits");
  const nitLine = nitsOn
    ? '- "nit":     a concrete, low-effort style/cleanup item. Use freely — the author opted into nits.'
    : `- "nit":     reserved. Do not use unless the issue is concrete, takes <30
             seconds to fix, and you'd still flag it if you had to defend it.`;
  return [
    "Severity scale (used in the JSON output):",
    '- "blocker": will break something real if merged.',
    '- "concern": an enabled-category issue worth addressing but not strictly merge-blocking.',
    nitLine,
    '- "praise":  do not use.',
  ].join("\n");
}

function scopeBlock(pathInclude: string, pathExclude: string): string {
  const inc = pathInclude.trim();
  const exc = pathExclude.trim();
  if (!inc && !exc) return "";
  const lines = ["# Scope"];
  if (inc)
    lines.push(
      `- Review ONLY files whose path matches one of: ${inc}. Ignore changes outside these paths.`,
    );
  if (exc) lines.push(`- Do NOT comment on files whose path matches: ${exc}.`);
  return lines.join("\n");
}

function rulesSection(cfg: ReviewInstructionConfig): string {
  const blocks: string[] = [];
  const add = (heading: string, body: string) => {
    const t = body.trim();
    if (t) blocks.push(`## ${heading}\n${t}`);
  };
  add("Global rules (apply to every PR)", cfg.globalRules);
  add("Repo rules", cfg.repoRules);
  add("This PR only", cfg.perPrRules);
  if (blocks.length === 0) {
    return "# Reviewer rules (follow these strictly)\n(none)";
  }
  return ["# Reviewer rules (follow these strictly)", ...blocks].join("\n\n");
}

/**
 * Assembles the instruction header from a resolved config. Exposed so the UI
 * can preview exactly what the model will be told before a review runs.
 */
export function buildReviewInstructions(cfg: ReviewInstructionConfig): string {
  const strictness = getStrictness(cfg.strictness);
  const parts = [
    PREAMBLE,
    "",
    `CRITICAL: ${strictness.framing}`,
    "",
    "ONLY comment when something falls into one of these categories:",
    "",
    categoriesBlock(cfg.categories),
    "",
    "DO NOT comment on any of the following:",
    suppressionsBlock(cfg.categories),
    "",
    severityScale(cfg.categories),
  ];
  const scope = scopeBlock(cfg.pathInclude, cfg.pathExclude);
  if (scope) {
    parts.push("", scope);
  }
  parts.push("", ANCHOR_INSTRUCTIONS);
  return parts.join("\n");
}

const OUTPUT_INSTRUCTIONS = `
At the very end of your response, return EXACTLY ONE fenced JSON code block
with this schema and nothing after it:

\`\`\`json
{
  "summary": "one short paragraph summarizing the review",
  "comments": [
    {
      "path": "src/foo.ts",
      "line": 42,
      "side": "RIGHT",
      "severity": "concern",
      "body": "Markdown body. Be specific. Reference symbols by name."
    }
  ]
}
\`\`\`

If you have no comments, return an empty "comments" array. That is the most
common outcome for a well-formed PR; do not invent comments to fill space.
`.trim();

export function buildReviewPrompt(ctx: ReviewContext): string {
  const threads = ctx.existingOpenThreads.length
    ? ctx.existingOpenThreads
        .map(
          (t) => `- ${t.path ?? "(no file)"}${t.line != null ? `:${t.line}` : ""} — ${t.summary}`,
        )
        .join("\n")
    : "(none)";
  return [
    buildReviewInstructions(ctx.config),
    "",
    `# Repository`,
    `${ctx.repoSlug} @ ${ctx.headSha} (base ${ctx.baseSha})`,
    "",
    `# Pull request #${ctx.prNumber}: ${ctx.prTitle}`,
    ctx.prBody.trim() || "(no description)",
    "",
    rulesSection(ctx.config),
    "",
    `# Existing open threads — do NOT duplicate these`,
    threads,
    "",
    `# Diff`,
    "```diff",
    ctx.diff,
    "```",
    "",
    OUTPUT_INSTRUCTIONS,
  ].join("\n");
}

export function buildReplyPrompt(ctx: ReplyContext): string {
  const anchor = ctx.threadAnchor.path
    ? `${ctx.threadAnchor.path}${ctx.threadAnchor.line != null ? `:${ctx.threadAnchor.line}` : ""}`
    : "(PR-level)";
  const history = ctx.threadHistory.map((m) => `**${m.author}:** ${m.body}`).join("\n\n");
  const skills = ctx.skills.trim() || "(none)";
  return [
    "You are continuing a code-review conversation on a pull request.",
    "You have read access to the working copy at the current cwd. Investigate before answering.",
    "Reply in markdown. Be concise. No JSON wrapping required.",
    "",
    `# Repository`,
    `${ctx.repoSlug} @ ${ctx.headSha}`,
    "",
    `# PR #${ctx.prNumber}: ${ctx.prTitle}`,
    "",
    `# Thread anchor: ${anchor}`,
    "",
    `# Reviewer rules for this repo`,
    skills,
    "",
    `# Conversation so far`,
    history,
    "",
    `# New user message`,
    ctx.userMessage,
    "",
    "Respond now.",
  ].join("\n");
}

const REVALIDATE_OUTPUT = `
At the very end of your response, return EXACTLY ONE fenced JSON code block
with this schema and nothing after it:

\`\`\`json
{
  "resolved": true,
  "explanation": "Short markdown explanation. If resolved, say what was fixed. If not, say specifically what's still missing or wrong, referencing files/lines."
}
\`\`\`
`.trim();

export function buildRevalidatePrompt(ctx: RevalidateContext): string {
  const anchor = ctx.threadAnchor.path
    ? `${ctx.threadAnchor.path}${ctx.threadAnchor.line != null ? `:${ctx.threadAnchor.line}` : ""}`
    : "(PR-level)";
  const history = ctx.threadHistory.map((m) => `**${m.author}:** ${m.body}`).join("\n\n");
  const skills = ctx.skills.trim() || "(none)";
  return [
    "You are revalidating a previously raised review thread against the CURRENT state of the working copy.",
    "",
    "Determine whether the concern raised in this thread has been addressed in the current code.",
    "Use your tools to look at the actual file(s) and surrounding code. Don't just trust the conversation.",
    "",
    `# Repository`,
    `${ctx.repoSlug} @ ${ctx.headSha} (base ${ctx.baseSha})`,
    "",
    `# PR #${ctx.prNumber}: ${ctx.prTitle}`,
    "",
    `# Thread anchor: ${anchor}`,
    "",
    `# Reviewer rules for this repo`,
    skills,
    "",
    `# Thread history (the original concern and any back-and-forth)`,
    history,
    "",
    "Now: investigate the current code and decide.",
    "- If the concern is fully addressed, set resolved=true.",
    "- If partially addressed or unaddressed, set resolved=false and explain exactly what is still missing.",
    "- If the original concern no longer applies (e.g., the code was removed), set resolved=true and say so.",
    "",
    REVALIDATE_OUTPUT,
  ].join("\n");
}
