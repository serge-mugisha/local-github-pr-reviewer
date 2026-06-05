import { describe, it, expect } from "vitest";
import { buildReviewInstructions } from "../packages/server/src/providers/prompt.js";
import type { ReviewInstructionConfig } from "../packages/server/src/providers/types.js";
import { DEFAULT_CATEGORIES } from "../packages/server/src/reviewCatalog.js";

function cfg(over: Partial<ReviewInstructionConfig> = {}): ReviewInstructionConfig {
  return {
    categories: [...DEFAULT_CATEGORIES],
    strictness: "balanced",
    globalRules: "",
    repoRules: "",
    perPrRules: "",
    pathInclude: "",
    pathExclude: "",
    ...over,
  };
}

describe("buildReviewInstructions", () => {
  it("lists only enabled categories, in catalog order", () => {
    const out = buildReviewInstructions(cfg({ categories: ["security", "bugs"] }));
    // Catalog order puts Bugs before Security regardless of input order.
    expect(out).toContain("1. **Bugs**");
    expect(out).toContain("2. **Security / data-integrity issues**");
    expect(out).not.toContain("**Code duplication**");
  });

  it("bans style comments by default", () => {
    const out = buildReviewInstructions(cfg());
    expect(out).toContain("Style, formatting, naming preferences");
    expect(out).toMatch(/"nit":\s+reserved/);
  });

  it("un-bans style and frees the nit severity when NITs are enabled", () => {
    const out = buildReviewInstructions(cfg({ categories: [...DEFAULT_CATEGORIES, "nits"] }));
    expect(out).not.toContain("- Style, formatting, naming preferences, import order, whitespace.");
    expect(out).toContain("opted into nits");
  });

  it("applies the selected strictness framing", () => {
    expect(buildReviewInstructions(cfg({ strictness: "minimal" }))).toContain(
      "Be extremely conservative",
    );
    expect(buildReviewInstructions(cfg({ strictness: "pedantic" }))).toContain("Be comprehensive");
  });

  it("emits a Scope block only when path filters are set", () => {
    expect(buildReviewInstructions(cfg())).not.toContain("# Scope");
    const scoped = buildReviewInstructions(
      cfg({ pathInclude: "src/auth/**", pathExclude: "*.lock" }),
    );
    expect(scoped).toContain("# Scope");
    expect(scoped).toContain("src/auth/**");
    expect(scoped).toContain("*.lock");
  });

  it("handles an empty category set without crashing", () => {
    const out = buildReviewInstructions(cfg({ categories: [] }));
    expect(out).toContain("no categories selected");
  });
});
