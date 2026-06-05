import type { ReviewCatalog } from "../api.js";

export interface ReviewConfigFields {
  categories: string[];
  strictness: string;
  customRules: string;
  pathInclude: string;
  pathExclude: string;
}

export function ReviewConfigEditor({
  catalog,
  value,
  onChange,
  showCategories = true,
  showStrictness = true,
  showCustomRules = true,
  showPaths = false,
  customRulesLabel = "Custom rules",
  customRulesPlaceholder,
  disabled = false,
}: {
  catalog: ReviewCatalog;
  value: ReviewConfigFields;
  onChange: (next: ReviewConfigFields) => void;
  showCategories?: boolean;
  showStrictness?: boolean;
  showCustomRules?: boolean;
  showPaths?: boolean;
  customRulesLabel?: string;
  customRulesPlaceholder?: string;
  disabled?: boolean;
}) {
  const toggleCategory = (key: string) => {
    const has = value.categories.includes(key);
    const categories = has ? value.categories.filter((k) => k !== key) : [...value.categories, key];
    onChange({ ...value, categories });
  };

  return (
    <div className="rc-editor">
      {showCategories && (
        <div className="rc-field">
          <div className="rc-label">What should the reviewer look for?</div>
          <div className="rc-categories">
            {catalog.categories.map((c) => {
              const on = value.categories.includes(c.key);
              return (
                <label
                  key={c.key}
                  className={`rc-chip ${on ? "on" : ""} ${disabled ? "disabled" : ""}`}
                  title={c.description}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={disabled}
                    onChange={() => toggleCategory(c.key)}
                  />
                  <span>{c.label}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}

      {showStrictness && (
        <div className="rc-field">
          <div className="rc-label">Strictness</div>
          <div className="rc-strictness" role="radiogroup" aria-label="Strictness">
            {catalog.strictness.map((s) => (
              <button
                key={s.key}
                type="button"
                role="radio"
                aria-checked={value.strictness === s.key}
                className={value.strictness === s.key ? "active" : ""}
                disabled={disabled}
                title={s.description}
                onClick={() => onChange({ ...value, strictness: s.key })}
              >
                {s.label}
              </button>
            ))}
          </div>
          <p className="rc-hint muted small">
            {catalog.strictness.find((s) => s.key === value.strictness)?.description}
          </p>
        </div>
      )}

      {showCustomRules && (
        <div className="rc-field">
          <div className="rc-label">{customRulesLabel}</div>
          <textarea
            className="rc-textarea"
            value={value.customRules}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, customRules: e.target.value })}
            placeholder={
              customRulesPlaceholder ??
              "Free text. e.g. “Flag any use of `any`. We just migrated auth — scrutinize src/auth/** hard.”"
            }
          />
        </div>
      )}

      {showPaths && (
        <div className="rc-paths">
          <div className="rc-field">
            <div className="rc-label">Only review (optional)</div>
            <input
              type="text"
              className="rc-input"
              value={value.pathInclude}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, pathInclude: e.target.value })}
              placeholder="src/auth/**, packages/server/**"
            />
          </div>
          <div className="rc-field">
            <div className="rc-label">Ignore (optional)</div>
            <input
              type="text"
              className="rc-input"
              value={value.pathExclude}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, pathExclude: e.target.value })}
              placeholder="*.lock, **/generated/**, dist/**"
            />
          </div>
        </div>
      )}
    </div>
  );
}
