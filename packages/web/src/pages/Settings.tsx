import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, type AppStatus, type Repo } from "../api.js";
import { AddRepoPanel } from "../components/AddRepoPanel.js";
import { GlobalRulesTab } from "../components/GlobalRulesTab.js";

type SettingsTab = "general" | "rules";

export function Settings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: SettingsTab = searchParams.get("tab") === "rules" ? "rules" : "general";
  const setTab = (t: SettingsTab) =>
    setSearchParams(t === "rules" ? { tab: "rules" } : {}, { replace: true });

  return (
    <div className="settings-page">
      <h1>Settings</h1>
      <div className="settings-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "general"}
          className={tab === "general" ? "active" : ""}
          onClick={() => setTab("general")}
        >
          General
        </button>
        <button
          role="tab"
          aria-selected={tab === "rules"}
          className={tab === "rules" ? "active" : ""}
          onClick={() => setTab("rules")}
        >
          Review rules
        </button>
      </div>
      {tab === "rules" ? <GlobalRulesTab /> : <GeneralSettings />}
    </div>
  );
}

function GeneralSettings() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [saving, setSaving] = useState(false);

  async function refresh() {
    const [s, r] = await Promise.all([api.status(), api.repos()]);
    setStatus(s);
    setRepos(r);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function switchProvider(id: string) {
    setSaving(true);
    try {
      await api.setProvider(id);
      await refresh();
    } finally {
      setSaving(false);
    }
  }

  async function doRemove(repo: Repo) {
    const ok = window.confirm(
      `Remove ${repo.owner}/${repo.name}?\nThis deletes all local reviews, threads, and skills for this repo. The clone on disk is left alone.`,
    );
    if (!ok) return;
    await api.removeRepo(repo.id);
    await refresh();
  }

  if (!status) return <div className="loading">Loading…</div>;

  return (
    <>
      <section>
        <h2>Repositories</h2>
        <p className="muted small">
          Map a local clone to its GitHub repo. The reviewer detects owner/name by running
          <code> gh repo view</code> inside the path you provide.
        </p>
        <ul className="repo-mgmt-list">
          {repos.map((r) => (
            <li key={r.id} className="repo-mgmt-row">
              <div>
                <div className="repo-mgmt-name">
                  {r.owner}/{r.name}
                </div>
                <div className="muted small mono">{r.localPath}</div>
              </div>
              <div className="spacer" />
              <button className="btn small danger" onClick={() => doRemove(r)}>
                Remove
              </button>
            </li>
          ))}
          {repos.length === 0 && <li className="muted">No repos yet — add one below.</li>}
        </ul>

        <AddRepoPanel onAdded={refresh} />
      </section>

      <section>
        <h2>AI provider</h2>
        <div className="provider-list">
          {status.providers.map((p) => (
            <label key={p.id} className={`provider-row ${!p.available ? "disabled" : ""}`}>
              <input
                type="radio"
                name="provider"
                value={p.id}
                checked={status.settings.provider === p.id}
                disabled={!p.available || saving}
                onChange={() => switchProvider(p.id)}
              />
              <span>{p.displayName}</span>
              <span className={`pill ${p.available ? "ok" : "warn"}`}>
                {p.available ? "CLI found" : "CLI missing"}
              </span>
            </label>
          ))}
        </div>
        <p className="muted small">
          “CLI found” means the executable is on PATH. Authentication is checked when a review runs.
        </p>
        <p className="muted small">
          Provider preference applies for the current server process. To persist across restarts,
          edit <code>config.json</code> in the project root.
        </p>
      </section>

      <section>
        <h2>GitHub CLI</h2>
        <p className={status.gh.ok ? "ok" : "warn"}>
          {status.gh.ok ? "Authenticated." : status.gh.message}
        </p>
        <p className="muted small">
          Reviewer never writes to GitHub. Only read endpoints of <code>gh</code> are reachable.
        </p>
      </section>

      <section>
        <h2>Server</h2>
        <p className="muted">
          Listening on{" "}
          <code>
            {status.settings.host}:{status.settings.port}
          </code>
        </p>
      </section>
    </>
  );
}
