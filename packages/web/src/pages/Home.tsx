import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type AppStatus, type PRListItem, type Repo } from "../api.js";

export function Home() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [prs, setPrs] = useState<Record<number, PRListItem[]>>({});
  const [loading, setLoading] = useState<Record<number, boolean>>({});

  useEffect(() => {
    api
      .status()
      .then(setStatus)
      .catch((e) => console.error(e));
    api.repos().then(async (r) => {
      setRepos(r);
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
    });
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

  return (
    <div className="home">
      <header className="home-header">
        <h1>Pull requests</h1>
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
                {p.displayName}
                {p.available ? "" : " (missing)"}
              </span>
            ))}
          </div>
        )}
      </header>

      {repos.length === 0 && (
        <div className="empty">
          <p>
            No repos configured. Edit <code>config.json</code> in the project root:
          </p>
          <pre>{`{
  "provider": "claude",
  "port": 47823,
  "repos": [
    { "owner": "your-user", "name": "your-repo", "localPath": "/abs/path/to/clone" }
  ]
}`}</pre>
        </div>
      )}

      {repos.map((repo) => (
        <section key={repo.id} className="repo-section">
          <div className="repo-header">
            <h2>
              {repo.owner}/{repo.name}
            </h2>
            <span className="muted small">{repo.localPath}</span>
            <div className="spacer" />
            <Link to={`/repos/${repo.id}/skills`} className="btn">
              Skills
            </Link>
            <button className="btn" onClick={() => refresh(repo.id)} disabled={loading[repo.id]}>
              {loading[repo.id] ? "Refreshing…" : "Refresh PRs"}
            </button>
          </div>
          <ul className="pr-list">
            {(prs[repo.id] ?? []).map((p) => (
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
            {(prs[repo.id]?.length ?? 0) === 0 && (
              <li className="pr-empty muted">No PRs cached. Click Refresh PRs.</li>
            )}
          </ul>
        </section>
      ))}
    </div>
  );
}
