import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, postSse, type AppStatus, type PRListItem, type Repo } from "../api.js";
import { AddRepoPanel } from "../components/AddRepoPanel.js";
import {
  filterAndSortPrs,
  flattenPrs,
  moveRepo,
  normalizeRepoOrder,
  sortRepos,
  type RepoPR,
} from "../homeData.js";
import {
  getPrefs,
  setPref,
  type HomeTab,
  type PrSortMode,
  type RepoSortMode,
  type RepoViewMode,
} from "../prefs.js";

function formatDate(value: string | undefined, fallback: string): string {
  value ||= fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function displayRepoName(repo: Pick<Repo, "owner" | "name">, showOwner: boolean): string {
  return showOwner ? `${repo.owner}/${repo.name}` : repo.name;
}

function RepoOwnerToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="check-label">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      Show owners
    </label>
  );
}

function PRRow({
  pr,
  reviewing,
  onReview,
  showRepo = false,
  showRepoOwner = false,
}: {
  pr: PRListItem | RepoPR;
  reviewing: boolean;
  onReview: () => void;
  showRepo?: boolean;
  showRepoOwner?: boolean;
}) {
  const repo = "repo" in pr ? pr.repo : null;
  return (
    <li className="pr-row">
      {showRepo && repo && (
        <span className="pill repo-pill" title={`${repo.owner}/${repo.name}`}>
          {displayRepoName(repo, showRepoOwner)}
        </span>
      )}
      <span className="pr-num">#{pr.number}</span>
      <Link to={`/pr/${pr.id}`} className="pr-title">
        {pr.title}
      </Link>
      <button
        type="button"
        className="btn small pr-row-action"
        onClick={onReview}
        disabled={reviewing || pr.reviewStatus === "running"}
        title="Run a review with the current default settings"
      >
        {(reviewing || pr.reviewStatus === "running") && (
          <span className="btn-spinner" aria-hidden />
        )}
        {reviewing || pr.reviewStatus === "running" ? "Reviewing…" : "Review"}
      </button>
      <a
        className="btn small pr-row-action"
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        title={`Open PR #${pr.number} on GitHub`}
      >
        GitHub ↗
      </a>
      {pr.author && <span className="muted small">{pr.author}</span>}
      {showRepo && (
        <time
          className="muted small pr-date"
          dateTime={pr.createdAt || pr.updatedAt}
          title={pr.createdAt || pr.updatedAt}
        >
          {formatDate(pr.createdAt, pr.updatedAt)}
        </time>
      )}
      <div className="spacer" />
      {pr.hasReview && <span className="pill ok">reviewed</span>}
      {pr.reviewStatus === "error" && <span className="pill warn">review failed</span>}
      {pr.openThreads > 0 && <span className="pill">{pr.openThreads} open</span>}
    </li>
  );
}

export function Home() {
  const prefs = getPrefs();
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [prs, setPrs] = useState<Record<number, PRListItem[]>>({});
  const [loading, setLoading] = useState<Record<number, boolean>>({});
  const [showAddRepo, setShowAddRepo] = useState(false);
  const [collapsedRepos, setCollapsedRepos] = useState<Set<number>>(
    () => new Set(prefs.collapsedRepoIds),
  );
  const [tab, setTabState] = useState<HomeTab>(prefs.homeTab);
  const [repoView, setRepoViewState] = useState<RepoViewMode>(prefs.repoViewMode);
  const [repoSort, setRepoSortState] = useState<RepoSortMode>(prefs.repoSortMode);
  const [repoOrder, setRepoOrder] = useState<number[]>(prefs.repoOrder);
  const [prSort, setPrSortState] = useState<PrSortMode>(prefs.prSortMode);
  const [ownedByMeOnly, setOwnedByMeOnlyState] = useState(prefs.ownedByMeOnly);
  const [reviewRequestedOnly, setReviewRequestedOnlyState] = useState(prefs.reviewRequestedOnly);
  const [showRepoOwner, setShowRepoOwnerState] = useState(prefs.showRepoOwner);
  const [draggedRepoId, setDraggedRepoId] = useState<number | null>(null);
  const [reviewingPrIds, setReviewingPrIds] = useState<Set<number>>(new Set());

  async function loadRepos() {
    const nextRepos = await api.repos();
    setRepos(nextRepos);
    const nextOrder = normalizeRepoOrder(nextRepos, getPrefs().repoOrder);
    setRepoOrder(nextOrder);
    setPref("repoOrder", nextOrder);
    setCollapsedRepos((current) => {
      const validRepoIds = new Set(nextRepos.map((repo) => repo.id));
      const next = new Set([...current].filter((repoId) => validRepoIds.has(repoId)));
      if (next.size !== current.size) setPref("collapsedRepoIds", [...next]);
      return next;
    });
    await Promise.all(
      nextRepos.map(async (repo) => {
        const cached = await api.prs(repo.id);
        setPrs((current) => ({ ...current, [repo.id]: cached }));
        setLoading((current) => ({ ...current, [repo.id]: true }));
        try {
          const fresh = await api.refreshPRs(repo.id);
          setPrs((current) => ({ ...current, [repo.id]: fresh }));
        } catch (error) {
          console.error(`refresh failed for ${repo.owner}/${repo.name}:`, error);
        } finally {
          setLoading((current) => ({ ...current, [repo.id]: false }));
        }
      }),
    );
  }

  useEffect(() => {
    api
      .status()
      .then(setStatus)
      .catch((error) => console.error(error));
    void loadRepos();
  }, []);

  const visibleRepos = useMemo(
    () => sortRepos(repos, prs, repoSort, repoOrder),
    [repos, prs, repoSort, repoOrder],
  );
  const visiblePrs = useMemo(
    () =>
      filterAndSortPrs(
        flattenPrs(repos, prs),
        prSort,
        status?.gh.login ?? null,
        ownedByMeOnly,
        reviewRequestedOnly,
      ),
    [repos, prs, prSort, status?.gh.login, ownedByMeOnly, reviewRequestedOnly],
  );

  function setTab(next: HomeTab) {
    setTabState(next);
    setPref("homeTab", next);
  }

  function setRepoView(next: RepoViewMode) {
    setRepoViewState(next);
    setPref("repoViewMode", next);
  }

  function setRepoSort(next: RepoSortMode) {
    setRepoSortState(next);
    setPref("repoSortMode", next);
  }

  function setPrSort(next: PrSortMode) {
    setPrSortState(next);
    setPref("prSortMode", next);
  }

  function setOwnedByMeOnly(next: boolean) {
    setOwnedByMeOnlyState(next);
    setPref("ownedByMeOnly", next);
  }

  function setReviewRequestedOnly(next: boolean) {
    setReviewRequestedOnlyState(next);
    setPref("reviewRequestedOnly", next);
  }

  function setShowRepoOwner(next: boolean) {
    setShowRepoOwnerState(next);
    setPref("showRepoOwner", next);
  }

  function saveRepoOrder(next: number[]) {
    setRepoOrder(next);
    setPref("repoOrder", next);
  }

  function moveRepoTo(repoId: number, targetIndex: number) {
    saveRepoOrder(moveRepo(repoOrder, repoId, targetIndex));
  }

  async function refresh(repoId: number) {
    setLoading((current) => ({ ...current, [repoId]: true }));
    try {
      const next = await api.refreshPRs(repoId);
      setPrs((current) => ({ ...current, [repoId]: next }));
    } finally {
      setLoading((current) => ({ ...current, [repoId]: false }));
    }
  }

  async function runQuickReview(prId: number, repoId: number) {
    setReviewingPrIds((current) => new Set(current).add(prId));
    setPrs((current) => ({
      ...current,
      [repoId]: (current[repoId] ?? []).map((pr) =>
        pr.id === prId ? { ...pr, reviewStatus: "running" } : pr,
      ),
    }));
    try {
      await postSse(`/api/prs/${prId}/review`, {}, () => {});
    } catch (error) {
      console.error(`review failed for PR ${prId}:`, error);
    } finally {
      try {
        const next = await api.prs(repoId);
        setPrs((current) => ({ ...current, [repoId]: next }));
      } catch (error) {
        console.error(`failed to refresh PR ${prId} after review:`, error);
      }
      setReviewingPrIds((current) => {
        const next = new Set(current);
        next.delete(prId);
        return next;
      });
    }
  }

  async function handleRepoAdded() {
    await loadRepos();
    setShowAddRepo(false);
  }

  function toggleRepo(repoId: number) {
    setCollapsedRepos((current) => {
      const next = new Set(current);
      if (next.has(repoId)) next.delete(repoId);
      else next.add(repoId);
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
              gh: {status.gh.ok ? (status.gh.login ?? "authed") : "not authed"}
            </span>
            {status.providers.map((provider) => (
              <span
                key={provider.id}
                className={`pill ${provider.available ? "ok" : "warn"} ${status.settings.provider === provider.id ? "active" : ""}`}
              >
                {provider.displayName}: {provider.available ? "found" : "missing"}
              </span>
            ))}
          </div>
        )}
        <button
          className="btn primary"
          onClick={() => setShowAddRepo((value) => !value)}
          aria-expanded={showAddRepo}
        >
          Add repo
        </button>
      </header>

      {showAddRepo && <AddRepoPanel onAdded={handleRepoAdded} />}

      <div className="home-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "repos"}
          className={tab === "repos" ? "active" : ""}
          onClick={() => setTab("repos")}
        >
          Repositories
        </button>
        <button
          role="tab"
          aria-selected={tab === "prs"}
          className={tab === "prs" ? "active" : ""}
          onClick={() => setTab("prs")}
        >
          All PRs <span className="tab-count">{flattenPrs(repos, prs).length}</span>
        </button>
      </div>

      {repos.length === 0 && (
        <div className="empty">
          <p>No repos configured. Use Add repo to choose a local clone and detect it.</p>
        </div>
      )}

      {repos.length > 0 && tab === "repos" && (
        <>
          <div className="home-toolbar">
            <label>
              <span className="muted small">Sort</span>
              <select
                value={repoSort}
                onChange={(event) => setRepoSort(event.target.value as RepoSortMode)}
              >
                <option value="manual">Manual order</option>
                <option value="name">Name</option>
                <option value="recent">Recent PR activity</option>
              </select>
            </label>
            <div className="view-toggle" role="group" aria-label="Repository view">
              <button
                className={repoView === "list" ? "active" : ""}
                aria-pressed={repoView === "list"}
                onClick={() => setRepoView("list")}
              >
                List
              </button>
              <button
                className={repoView === "grid" ? "active" : ""}
                aria-pressed={repoView === "grid"}
                onClick={() => setRepoView("grid")}
              >
                Grid
              </button>
            </div>
            <RepoOwnerToggle checked={showRepoOwner} onChange={setShowRepoOwner} />
            {repoSort === "manual" && (
              <span className="muted small">Drag repos or use the arrow buttons to reorder.</span>
            )}
          </div>
          <div className={`repo-collection ${repoView}`}>
            {visibleRepos.map((repo) => {
              const isCollapsed = collapsedRepos.has(repo.id);
              const repoPrs = prs[repo.id] ?? [];
              const orderIndex = repoOrder.indexOf(repo.id);
              return (
                <section
                  key={repo.id}
                  className={`repo-section ${isCollapsed ? "collapsed" : ""} ${draggedRepoId === repo.id ? "dragging" : ""}`}
                  onDragEnd={() => setDraggedRepoId(null)}
                  onDragOver={(event) => {
                    if (repoSort === "manual") event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (draggedRepoId !== null) moveRepoTo(draggedRepoId, orderIndex);
                    setDraggedRepoId(null);
                  }}
                >
                  <div className="repo-header">
                    {repoSort === "manual" && (
                      <span
                        className="repo-drag"
                        draggable
                        aria-hidden
                        title="Drag to reorder"
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = "move";
                          setDraggedRepoId(repo.id);
                        }}
                      >
                        ⠿
                      </span>
                    )}
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
                      <span className="repo-title" title={`${repo.owner}/${repo.name}`}>
                        {displayRepoName(repo, showRepoOwner)}
                      </span>
                      <span className="muted small">{repo.localPath}</span>
                    </button>
                    <span className="pill">{repoPrs.length} PRs</span>
                    <div className="spacer" />
                    {repoSort === "manual" && (
                      <div className="repo-move-buttons">
                        <button
                          className="btn icon"
                          disabled={orderIndex <= 0}
                          onClick={() => moveRepoTo(repo.id, orderIndex - 1)}
                          aria-label={`Move ${repo.owner}/${repo.name} up`}
                          title="Move up"
                        >
                          ↑
                        </button>
                        <button
                          className="btn icon"
                          disabled={orderIndex < 0 || orderIndex >= repoOrder.length - 1}
                          onClick={() => moveRepoTo(repo.id, orderIndex + 1)}
                          aria-label={`Move ${repo.owner}/${repo.name} down`}
                          title="Move down"
                        >
                          ↓
                        </button>
                      </div>
                    )}
                    <Link to={`/repos/${repo.id}/skills`} className="btn">
                      Skills
                    </Link>
                    <button
                      className="btn"
                      onClick={() => refresh(repo.id)}
                      disabled={loading[repo.id]}
                    >
                      {loading[repo.id] ? "Refreshing…" : "Refresh PRs"}
                    </button>
                  </div>
                  {!isCollapsed && (
                    <ul className="pr-list">
                      {repoPrs.map((pr) => (
                        <PRRow
                          key={pr.id}
                          pr={pr}
                          reviewing={reviewingPrIds.has(pr.id)}
                          onReview={() => void runQuickReview(pr.id, repo.id)}
                        />
                      ))}
                      {repoPrs.length === 0 && <li className="pr-empty muted">No open PRs.</li>}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        </>
      )}

      {repos.length > 0 && tab === "prs" && (
        <>
          <div className="home-toolbar">
            <label>
              <span className="muted small">Created</span>
              <select
                value={prSort}
                onChange={(event) => setPrSort(event.target.value as PrSortMode)}
              >
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
              </select>
            </label>
            <label className={`check-label ${status && !status.gh.login ? "disabled" : ""}`}>
              <input
                type="checkbox"
                checked={ownedByMeOnly}
                disabled={status !== null && !status.gh.login}
                onChange={(event) => setOwnedByMeOnly(event.target.checked)}
              />
              Owned by me
            </label>
            <label className={`check-label ${status && !status.gh.login ? "disabled" : ""}`}>
              <input
                type="checkbox"
                checked={reviewRequestedOnly}
                disabled={status !== null && !status.gh.login}
                onChange={(event) => setReviewRequestedOnly(event.target.checked)}
              />
              Review requested
            </label>
            {status && !status.gh.login && (
              <span className="muted small">
                {status.gh.ok
                  ? "Restart Reviewer to load your GitHub identity."
                  : "Authenticate GitHub to use personal filters."}
              </span>
            )}
            <RepoOwnerToggle checked={showRepoOwner} onChange={setShowRepoOwner} />
          </div>
          <section className="all-prs-section">
            <ul className="pr-list all-pr-list">
              {visiblePrs.map((pr) => (
                <PRRow
                  key={pr.id}
                  pr={pr}
                  reviewing={reviewingPrIds.has(pr.id)}
                  onReview={() => void runQuickReview(pr.id, pr.repo.id)}
                  showRepo
                  showRepoOwner={showRepoOwner}
                />
              ))}
              {visiblePrs.length === 0 && <li className="pr-empty muted">No matching open PRs.</li>}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
