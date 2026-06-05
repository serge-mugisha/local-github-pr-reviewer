import { useEffect, useState } from "react";
import { api, type ReviewCatalog, type RulePreset } from "../api.js";
import { ReviewConfigEditor, type ReviewConfigFields } from "./ReviewConfigEditor.js";

const EMPTY_PATHS = { pathInclude: "", pathExclude: "" };

export function GlobalRulesTab() {
  const [catalog, setCatalog] = useState<ReviewCatalog | null>(null);
  const [global, setGlobal] = useState<ReviewConfigFields | null>(null);
  const [presets, setPresets] = useState<RulePreset[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState("");

  useEffect(() => {
    void (async () => {
      const [cat, g, ps] = await Promise.all([
        api.reviewCatalog(),
        api.globalReviewConfig(),
        api.presets(),
      ]);
      setCatalog(cat);
      setGlobal({ ...g, ...EMPTY_PATHS });
      setPresets(ps);
    })();
  }, []);

  async function saveGlobal() {
    if (!global) return;
    setSaving(true);
    try {
      await api.saveGlobalReviewConfig({
        categories: global.categories,
        strictness: global.strictness,
        customRules: global.customRules,
      });
      setSavedAt(new Date().toLocaleTimeString());
    } finally {
      setSaving(false);
    }
  }

  if (!catalog || !global) return <div className="loading">Loading…</div>;

  return (
    <div className="global-rules-tab">
      <section>
        <h2>Global defaults</h2>
        <p className="muted small">
          These categories and strictness seed every PR that hasn't been customized. The custom
          rules below are added to <strong>every</strong> review, in every repo. Reviewer never
          writes any of this back to your repositories.
        </p>
        <ReviewConfigEditor
          catalog={catalog}
          value={global}
          onChange={setGlobal}
          customRulesLabel="Global custom rules (apply to every PR)"
          customRulesPlaceholder="e.g. “Never approve a console.log left in shipped code. Treat any new env var as a security-review trigger.”"
        />
        <div className="row">
          <button className="btn primary" onClick={() => void saveGlobal()} disabled={saving}>
            {saving ? "Saving…" : "Save global defaults"}
          </button>
          {savedAt && <span className="muted small">Saved {savedAt}</span>}
        </div>
      </section>

      <PresetsSection catalog={catalog} presets={presets} onChange={(ps) => setPresets(ps)} />
    </div>
  );
}

function summarize(catalog: ReviewCatalog, p: RulePreset): string {
  const cats = catalog.categories.filter((c) => p.categories.includes(c.key)).map((c) => c.label);
  const strictness = catalog.strictness.find((s) => s.key === p.strictness)?.label ?? p.strictness;
  return `${cats.length ? cats.join(", ") : "no categories"} · ${strictness}`;
}

function PresetsSection({
  catalog,
  presets,
  onChange,
}: {
  catalog: ReviewCatalog;
  presets: RulePreset[];
  onChange: (presets: RulePreset[]) => void;
}) {
  const [editing, setEditing] = useState<RulePreset | "new" | null>(null);

  async function remove(id: number) {
    if (!window.confirm("Delete this preset?")) return;
    await api.deletePreset(id);
    onChange(presets.filter((p) => p.id !== id));
  }

  function upsertLocal(saved: RulePreset) {
    const exists = presets.some((p) => p.id === saved.id);
    const next = exists ? presets.map((p) => (p.id === saved.id ? saved : p)) : [...presets, saved];
    onChange(next.sort((a, b) => a.name.localeCompare(b.name)));
  }

  return (
    <section>
      <h2>Presets</h2>
      <p className="muted small">
        Named bundles of categories, strictness, and custom rules. Apply one to any PR in a click
        from its Review settings panel.
      </p>
      <ul className="preset-list">
        {presets.map((p) => (
          <li key={p.id} className="preset-row">
            <div>
              <div className="preset-name">{p.name}</div>
              <div className="muted small">{summarize(catalog, p)}</div>
            </div>
            <div className="spacer" />
            <button className="btn small" onClick={() => setEditing(p)}>
              Edit
            </button>
            <button className="btn small danger" onClick={() => void remove(p.id)}>
              Delete
            </button>
          </li>
        ))}
        {presets.length === 0 && <li className="muted">No presets yet.</li>}
      </ul>

      {editing === null ? (
        <button className="btn" onClick={() => setEditing("new")}>
          + New preset
        </button>
      ) : (
        <PresetEditor
          catalog={catalog}
          preset={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            upsertLocal(saved);
            setEditing(null);
          }}
        />
      )}
    </section>
  );
}

function PresetEditor({
  catalog,
  preset,
  onClose,
  onSaved,
}: {
  catalog: ReviewCatalog;
  preset: RulePreset | null;
  onClose: () => void;
  onSaved: (saved: RulePreset) => void;
}) {
  const [name, setName] = useState(preset?.name ?? "");
  const [fields, setFields] = useState<ReviewConfigFields>({
    categories:
      preset?.categories ?? catalog.categories.filter((c) => c.defaultOn).map((c) => c.key),
    strictness: preset?.strictness ?? "balanced",
    customRules: preset?.customRules ?? "",
    ...EMPTY_PATHS,
  });
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        categories: fields.categories,
        strictness: fields.strictness,
        customRules: fields.customRules,
      };
      const saved = preset
        ? await api.updatePreset(preset.id, payload)
        : await api.createPreset(payload);
      onSaved(saved);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="preset-editor">
      <div className="rc-field">
        <div className="rc-label">Preset name</div>
        <input
          type="text"
          className="rc-input"
          value={name}
          placeholder="e.g. Security audit"
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <ReviewConfigEditor
        catalog={catalog}
        value={fields}
        onChange={setFields}
        customRulesLabel="Custom rules in this preset"
      />
      <div className="row">
        <button
          className="btn primary"
          onClick={() => void save()}
          disabled={saving || !name.trim()}
        >
          {saving ? "Saving…" : preset ? "Update preset" : "Create preset"}
        </button>
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
