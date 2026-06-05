import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type ReviewCatalog, type RulePreset } from "../api.js";
import { ReviewConfigEditor, type ReviewConfigFields } from "./ReviewConfigEditor.js";

const AUTOSAVE_MS = 700;

function summarize(catalog: ReviewCatalog, cfg: ReviewConfigFields): string {
  const labels = catalog.categories
    .filter((c) => cfg.categories.includes(c.key))
    .map((c) => c.label);
  const strictness =
    catalog.strictness.find((s) => s.key === cfg.strictness)?.label ?? cfg.strictness;
  const cats = labels.length ? labels.join(", ") : "no categories";
  return `${cats} · ${strictness}`;
}

export function ReviewSettingsPanel({
  prId,
  onConfigChange,
  disabled = false,
}: {
  prId: number;
  onConfigChange?: (cfg: ReviewConfigFields) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<ReviewCatalog | null>(null);
  const [presets, setPresets] = useState<RulePreset[]>([]);
  const [cfg, setCfg] = useState<ReviewConfigFields | null>(null);
  const [customized, setCustomized] = useState(false);
  const [savedAt, setSavedAt] = useState<string>("");
  const [preview, setPreview] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [presetName, setPresetName] = useState("");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [cat, pr, ps] = await Promise.all([
        api.reviewCatalog(),
        api.prReviewConfig(prId),
        api.presets(),
      ]);
      if (!alive) return;
      setCatalog(cat);
      setPresets(ps);
      setCustomized(pr.customized);
      const fields: ReviewConfigFields = {
        categories: pr.categories,
        strictness: pr.strictness,
        customRules: pr.customRules,
        pathInclude: pr.pathInclude,
        pathExclude: pr.pathExclude,
      };
      setCfg(fields);
      onConfigChange?.(fields);
    })();
    return () => {
      alive = false;
    };
    // onConfigChange is a stable ref-setter from the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prId]);

  const persist = useCallback(
    async (fields: ReviewConfigFields) => {
      const saved = await api.savePrReviewConfig(prId, fields);
      setCustomized(saved.customized);
      setSavedAt(new Date().toLocaleTimeString());
    },
    [prId],
  );

  const update = useCallback(
    (next: ReviewConfigFields) => {
      setCfg(next);
      setPreview(null);
      onConfigChange?.(next);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void persist(next), AUTOSAVE_MS);
    },
    [persist, onConfigChange],
  );

  const resetToGlobal = useCallback(async () => {
    const reset = await api.resetPrReviewConfig(prId);
    const fields: ReviewConfigFields = {
      categories: reset.categories,
      strictness: reset.strictness,
      customRules: reset.customRules,
      pathInclude: reset.pathInclude,
      pathExclude: reset.pathExclude,
    };
    setCfg(fields);
    setCustomized(false);
    setPreview(null);
    setSavedAt("");
    onConfigChange?.(fields);
  }, [prId, onConfigChange]);

  const applyPreset = useCallback(
    (preset: RulePreset) => {
      if (!cfg) return;
      update({
        ...cfg,
        categories: preset.categories,
        strictness: preset.strictness,
        customRules: preset.customRules,
      });
    },
    [cfg, update],
  );

  const saveAsPreset = useCallback(async () => {
    if (!cfg || !presetName.trim()) return;
    const created = await api.createPreset({
      name: presetName.trim(),
      categories: cfg.categories,
      strictness: cfg.strictness,
      customRules: cfg.customRules,
    });
    setPresets((p) => [...p, created].sort((a, b) => a.name.localeCompare(b.name)));
    setPresetName("");
  }, [cfg, presetName]);

  const doPreview = useCallback(async () => {
    if (!cfg) return;
    setPreviewing(true);
    try {
      const { instructions } = await api.previewReviewConfig(prId, cfg);
      setPreview(instructions);
    } finally {
      setPreviewing(false);
    }
  }, [cfg, prId]);

  if (!catalog || !cfg) {
    return <div className="review-settings-panel loading-stub" />;
  }

  return (
    <div className={`review-settings-panel ${open ? "open" : "closed"}`}>
      <button
        type="button"
        className="rsp-bar"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={`chevron ${open ? "down" : "right"}`} aria-hidden>
          ▾
        </span>
        <span className="rsp-title">Review settings</span>
        <span className="rsp-summary muted">{summarize(catalog, cfg)}</span>
        <span className="spacer" />
        <span className={`pill ${customized ? "open" : "ok"}`}>
          {customized ? "Customized" : "Global defaults"}
        </span>
      </button>

      {open && (
        <div className="rsp-body">
          <div className="rsp-presets">
            <label className="rsp-preset-apply">
              <span className="muted small">Apply preset</span>
              <select
                value=""
                disabled={disabled || presets.length === 0}
                onChange={(e) => {
                  const p = presets.find((x) => x.id === Number(e.target.value));
                  if (p) applyPreset(p);
                }}
              >
                <option value="" disabled>
                  {presets.length ? "Choose a preset…" : "No presets yet"}
                </option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="spacer" />
            <Link to="/settings?tab=rules" className="muted small">
              Manage defaults & presets →
            </Link>
          </div>

          <ReviewConfigEditor
            catalog={catalog}
            value={cfg}
            onChange={update}
            showPaths
            disabled={disabled}
            customRulesLabel="Custom rules for this PR"
            customRulesPlaceholder="What matters most on THIS PR? e.g. “This refactors the retry path — watch for dropped errors and changed backoff.”"
          />

          <div className="rsp-actions">
            <div className="rsp-save-preset">
              <input
                type="text"
                className="rc-input"
                value={presetName}
                placeholder="Save current as preset…"
                onChange={(e) => setPresetName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveAsPreset();
                }}
              />
              <button
                className="btn small"
                onClick={() => void saveAsPreset()}
                disabled={!presetName.trim()}
              >
                Save preset
              </button>
            </div>
            <div className="spacer" />
            <button
              className="btn small ghost"
              onClick={() => void doPreview()}
              disabled={previewing}
            >
              {previewing ? "…" : preview ? "Refresh preview" : "Preview prompt"}
            </button>
            {customized && (
              <button className="btn small" onClick={() => void resetToGlobal()}>
                Reset to global
              </button>
            )}
            {savedAt && <span className="muted small">Saved {savedAt}</span>}
          </div>

          {preview !== null && (
            <details className="rsp-preview" open>
              <summary>Prompt preview — what the model will be told</summary>
              <pre>{preview}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
