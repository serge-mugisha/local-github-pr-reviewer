import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type AppStatus, type PRListItem, type Repo } from "../api.js";
import { AddRepoPanel } from "../components/AddRepoPanel.js";
import { getPrefs, setPref } from "../prefs.js";

export function Home() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [prs, setPrs] = useState<Record<number, PRListItem[]>>({});
  const [loading, setLoading] = useState<Record<number, boolean>>({});
  const [showAddRepo, setShowAddRepo] = useState(false);
  const [collapsedRepos, setCollapsedRepos] = useState<Set<number>>(
    () => new Set(getPrefs().collapsedRepoIds),
  );

  async function loadRepos() {
    const r = await api.repos();
    setRepos(r);
    setCollapsedRepos((current) => {
      const validRepoIds = new Set(r.map((repo) => repo.id));
      const next = new Set([...current].filter((repoId) => validRepoIds.has(repoId)));
      if (next.size !== current.size) setPref("collapsedRepoIds", [...next]);
      return next;
    });
    // For each repo: show cached PRs immediately, then trigger a refresh
    // in the background so the list converges to whatever's actually open
    // on GitHub. Refresh empty repos eagerly (no cache to show first).
    await Promise.all(
      r.map(async (repo) => {
        const cached = await api.prs(repo.id);
        setPrs((p) => ({ ...p, [repo.id]: cached }));
        setLoading((l) => ({ ...l, [repo.id]: true }));
        try {
          const fresh = await api.refreshPRs(repo.id);
          setPrs((p) => ({ ...p, [repo.id]: fresh }));
        } catch (e) {
          console.error(`refresh failed for ${repo.owner}/${repo.name}:`, e);
        } finally {
          setLoading((l) => ({ ...l, [repo.id]: false }));
        }
      }),
    );
  }

  useEffect(() => {
    api
      .status()
      .then(setStatus)
      .catch((e) => console.error(e));
    void loadRepos();
  }, []);

  async function refresh(repoId: number) {
    setLoading((l) => ({ ...l, [repoId]: true }));
    try {
      const next = await api.refreshPRs(repoId);
      setPrs((p) => ({ ...p, [repoId]: next }));
    } finally {
      setLoading((l) => ({ ...l, [repoId]: false }));
    }
  }

  async function handleRepoAdded() {
    await loadRepos();
    setShowAddRepo(false);
  }

  function toggleRepo(repoId: number) {
    setCollapsedRepos((current) => {
      const next = new Set(current);
      if (next.has(repoId)) {
        next.delete(repoId);
      } else {
        next.add(repoId);
      }
      setPref("collapsedRepoIds", [...next]);
      return next;
    });
  }

  return (
    <div className="home">
      <header className="home-header">
        <h1>Pull requests</h1>
        <div className="spacer" />
        {status && (
          <div className="status-strip">
            <span className={`pill ${status.gh.ok ? "ok" : "warn"}`}>
              gh: {status.gh.ok ? "authed" : "not authed"}
            </span>
            {status.providers.map((p) => (
              <span
                key={p.id}
                className={`pill ${p.available ? "ok" : "warn"} ${status.settings.provider === p.id ? "active" : ""}`}
              >
                {p.displayName}: {p.available ? "found" : "missing"}
              </span>
            ))}
          </div>
        )}
        <button
          className="btn primary"
          onClick={() => setShowAddRepo((v) => !v)}
          aria-expanded={showAddRepo}
        >
          Add repo
        </button>
      </header>

      {showAddRepo && <AddRepoPanel onAdded={handleRepoAdded} />}

      {repos.length === 0 && (
        <div className="empty">
          <p>No repos configured. Use Add repo to choose a local clone and detect it.</p>
        </div>
      )}

      {repos.map((repo) => {
        const isCollapsed = collapsedRepos.has(repo.id);
        const repoPrs = prs[repo.id] ?? [];
        return (
          <section key={repo.id} className={`repo-section ${isCollapsed ? "collapsed" : ""}`}>
            <div className="repo-header">
              <button
                type="button"
                className="file-fold repo-fold"
                onClick={() => toggleRepo(repo.id)}
                aria-expanded={!isCollapsed}
                aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${repo.owner}/${repo.name}`}
                title={isCollapsed ? "Expand repo" : "Collapse repo"}
              >
                <span className={`chevron ${isCollapsed ? "right" : "down"}`} aria-hidden>
                  ▾
                </span>
              </button>
              <button
                type="button"
                className="repo-title-toggle"
                onClick={() => toggleRepo(repo.id)}
                aria-expanded={!isCollapsed}
              >
                <span className="repo-title">
                  {repo.owner}/{repo.name}
                </span>
                <span className="muted small">{repo.localPath}</span>
              </button>
              <span className="pill">{repoPrs.length} PRs</span>
              <div className="spacer" />
              <Link to={`/repos/${repo.id}/skills`} className="btn">
                Skills
              </Link>
              <button className="btn" onClick={() => refresh(repo.id)} disabled={loading[repo.id]}>
                {loading[repo.id] ? "Refreshing…" : "Refresh PRs"}
              </button>
            </div>
            {!isCollapsed && (
              <ul className="pr-list">
                {repoPrs.map((p) => (
                  <li key={p.id} className="pr-row">
                    <span className="pr-num">#{p.number}</span>
                    <Link to={`/pr/${p.id}`} className="pr-title">
                      {p.title}
                    </Link>
                    <span className="branch">
                      {p.headRef} → {p.baseRef}
                    </span>
                    {p.author && <span className="muted small">{p.author}</span>}
                    <div className="spacer" />
                    {p.hasReview && <span className="pill ok">reviewed</span>}
                    {p.openThreads > 0 && <span className="pill">{p.openThreads} open</span>}
                  </li>
                ))}
                {repoPrs.length === 0 && (
                  <li className="pr-empty muted">No PRs cached. Click Refresh PRs.</li>
                )}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
