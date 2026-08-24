import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PatchDiff, type DiffLineAnnotation } from "@pierre/diffs/react";
import { api, errorHasPersistedInput, postSse, type PRDetail, type Thread } from "../api.js";
import { Markdown } from "../components/Markdown.js";
import { ReviewSettingsPanel } from "../components/ReviewSettingsPanel.js";
import type { ReviewConfigFields } from "../components/ReviewConfigEditor.js";
import { splitPatchByFile, parseUnifiedDiff, type PatchFile } from "../diff.js";
import { sortFiles, statsForThreads, SEVERITY_RANK, NO_SEVERITY_RANK } from "../fileSort.js";
import { getTheme, subscribeTheme, type Theme } from "../theme.js";
import { getPrefs, setPref, subscribePrefs, type ViewMode, type Prefs } from "../prefs.js";

type LineThreads = DiffLineAnnotation<Thread[]>;

function useThemeType(): Theme {
  const [theme, setThemeState] = useState<Theme>(() => getTheme());
  useEffect(() => subscribeTheme(setThemeState), []);
  return theme;
}

function usePrefs(): Prefs {
  const [prefs, setPrefs] = useState<Prefs>(() => getPrefs());
  useEffect(() => subscribePrefs(setPrefs), []);
  return prefs;
}

type StreamState = {
  active: boolean;
  log: string[];
  /** `null` while idle / running. Set when a run completes (success or fail)
   *  so the UI can show the right "after-run" state. */
  result: { addedThreads: number; staleMarked: number } | null;
  error: string | null;
};

const BODY_PEEK_CHARS = 240;

export function PRView() {
  const { prId } = useParams();
  const id = Number(prId);
  const [detail, setDetail] = useState<PRDetail | null>(null);
  const [savingProvider, setSavingProvider] = useState(false);
  const [diff, setDiff] = useState<string>("");
  const [stream, setStream] = useState<StreamState>({
    active: false,
    log: [],
    result: null,
    error: null,
  });
  const [showLog, setShowLog] = useState(false);
  const [dismissedReviewErrorId, setDismissedReviewErrorId] = useState<number | null>(null);
  const reviewConfigRef = useRef<ReviewConfigFields | null>(null);

  const load = useCallback(async () => {
    const [d, df] = await Promise.all([api.pr(id), api.diff(id)]);
    setDetail(d);
    setDiff(df);
  }, [id]);

  const loadReviewSnapshot = useCallback(
    async (isCancelled: () => boolean = () => false) => {
      const snapshot = await api.reviewSnapshot(id);
      if (isCancelled()) return;
      setDetail((current) => {
        if (!current) return current;
        const completed = snapshot.lastReview;
        const summaryReview =
          completed?.status === "done" && completed.summary?.trim()
            ? {
                id: completed.id,
                headSha: completed.headSha,
                provider: completed.provider,
                summary: completed.summary,
                finishedAt: completed.finishedAt,
              }
            : current.summaryReview;
        return {
          ...current,
          threads: snapshot.threads,
          lastReview: snapshot.lastReview,
          summaryReview,
        };
      });
    },
    [id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const persistedReviewActive = detail?.lastReview?.status === "running";
  const reviewActive = stream.active || persistedReviewActive;

  // An SSE stream belongs to the page that started it. When the user returns
  // to this PR, follow the persisted review row until it reaches a final state.
  useEffect(() => {
    if (!persistedReviewActive || stream.active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const lastReview = await api.reviewStatus(id);
        if (cancelled) return;
        if (lastReview?.status === "running") {
          setDetail((current) => (current ? { ...current, lastReview } : current));
          timer = setTimeout(poll, 2000);
        } else {
          await loadReviewSnapshot(() => cancelled);
        }
      } catch (error) {
        console.error(error);
        if (!cancelled) timer = setTimeout(poll, 4000);
      }
    };

    timer = setTimeout(poll, 1000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [id, loadReviewSnapshot, persistedReviewActive, stream.active]);

  const files = useMemo<PatchFile[]>(() => (diff ? splitPatchByFile(diff) : []), [diff]);

  // The exact (line:side) positions @pierre/diffs will render per file. An
  // inline annotation on any other line is silently dropped by the renderer,
  // so we use this to detect anchors that won't show and re-home them.
  const renderableLines = useMemo(() => {
    const map = new Map<string, Set<string>>();
    if (!diff) return map;
    for (const f of parseUnifiedDiff(diff)) {
      const keys = new Set<string>();
      for (const h of f.hunks) {
        for (const ln of h.lines) {
          if (ln.newLine != null && (ln.kind === "add" || ln.kind === "context"))
            keys.add(`${ln.newLine}:additions`);
          if (ln.oldLine != null && (ln.kind === "del" || ln.kind === "context"))
            keys.add(`${ln.oldLine}:deletions`);
        }
      }
      map.set(f.newPath, keys);
    }
    return map;
  }, [diff]);

  // Index threads by file. An inline thread renders inline only when its file
  // is in the diff AND its line is in a rendered hunk; otherwise it falls back
  // to the file-level block (file present) or the orphan section (file absent),
  // so a flagged comment is never lost.
  const { threadsByFile, inlineByFile, fileLevelByFile, prLevel, orphanThreads } = useMemo(() => {
    const threadsByFile = new Map<string, Thread[]>();
    const inlineByFile = new Map<string, Map<string, Thread[]>>();
    const fileLevelByFile = new Map<string, Thread[]>();
    const prLevel: Thread[] = [];
    const orphanThreads: Thread[] = [];
    if (!detail) return { threadsByFile, inlineByFile, fileLevelByFile, prLevel, orphanThreads };
    const inDiff = renderableLines.size > 0 ? renderableLines : null;
    for (const t of detail.threads) {
      if (!t.filePath) {
        prLevel.push(t);
        continue;
      }
      // File isn't in the diff at all — nowhere to anchor it.
      if (inDiff && !inDiff.has(t.filePath)) {
        orphanThreads.push(t);
        continue;
      }
      const all = threadsByFile.get(t.filePath) ?? [];
      all.push(t);
      threadsByFile.set(t.filePath, all);
      const side = t.side === "LEFT" ? "deletions" : "additions";
      const key = `${t.line}:${side}`;
      const renderable = t.line != null && (!inDiff || (inDiff.get(t.filePath)?.has(key) ?? true));
      if (t.line == null || !renderable) {
        const arr = fileLevelByFile.get(t.filePath) ?? [];
        arr.push(t);
        fileLevelByFile.set(t.filePath, arr);
        continue;
      }
      const byLine = inlineByFile.get(t.filePath) ?? new Map<string, Thread[]>();
      const arr = byLine.get(key) ?? [];
      arr.push(t);
      byLine.set(key, arr);
      inlineByFile.set(t.filePath, byLine);
    }
    return { threadsByFile, inlineByFile, fileLevelByFile, prLevel, orphanThreads };
  }, [detail, renderableLines]);

  const annByFile = useMemo(() => {
    const out = new Map<string, LineThreads[]>();
    for (const [path, byLine] of inlineByFile) {
      const anns: LineThreads[] = [];
      for (const [key, threads] of byLine) {
        const [line, side] = key.split(":");
        anns.push({
          side: side as "additions" | "deletions",
          lineNumber: Number(line),
          metadata: threads,
        });
      }
      out.set(path, anns);
    }
    return out;
  }, [inlineByFile]);

  const sortedFiles = useMemo(() => sortFiles(files, threadsByFile), [files, threadsByFile]);

  const themeType = useThemeType();
  const prefs = usePrefs();
  const viewMode = prefs.viewMode;
  const sidenavCollapsed = prefs.sidenavCollapsed;
  const setViewMode = (m: ViewMode) => setPref("viewMode", m);
  const toggleSidenav = () => setPref("sidenavCollapsed", !sidenavCollapsed);

  // Per-file collapsed/viewed state. Marking viewed auto-collapses.
  const [collapsedByFile, setCollapsedByFile] = useState<Set<string>>(new Set());
  const [viewedSet, setViewedSet] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!detail) return;
    setViewedSet(new Set(detail.viewedFiles));
    setCollapsedByFile((prev) => {
      const next = new Set(prev);
      for (const p of detail.viewedFiles) next.add(p);
      return next;
    });
  }, [detail]);

  const toggleCollapsed = useCallback((path: string) => {
    setCollapsedByFile((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const setViewed = useCallback(
    async (path: string, viewed: boolean) => {
      setViewedSet((prev) => {
        const next = new Set(prev);
        if (viewed) next.add(path);
        else next.delete(path);
        return next;
      });
      setCollapsedByFile((prev) => {
        const next = new Set(prev);
        if (viewed) next.add(path);
        else next.delete(path);
        return next;
      });
      try {
        const { viewedFiles } = await api.setFileViewed(id, path, viewed);
        setViewedSet(new Set(viewedFiles));
      } catch (e) {
        console.error(e);
        setViewedSet((prev) => {
          const next = new Set(prev);
          if (viewed) next.delete(path);
          else next.add(path);
          return next;
        });
      }
    },
    [id],
  );

  // The diff's sticky file headers must pin just below the topbar + sticky PR
  // header. The PR header height varies with the title, so we measure it and
  // expose the offset as a CSS variable (custom props inherit through the
  // diff's shadow DOM, where the sticky `top` is applied via unsafeCSS).
  const prHeaderRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = prHeaderRef.current;
    if (!el) return;
    const root = document.documentElement;
    const update = () => {
      const topbarH = (document.querySelector(".topbar") as HTMLElement | null)?.offsetHeight ?? 56;
      root.style.setProperty("--diff-sticky-top", `${topbarH + el.offsetHeight}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [detail]);

  // File anchors for sidenav jump.
  const fileRefs = useRef<Map<string, HTMLElement>>(new Map());
  const registerFileEl = useCallback((path: string, el: HTMLElement | null) => {
    if (el) fileRefs.current.set(path, el);
    else fileRefs.current.delete(path);
  }, []);
  const scrollToFile = useCallback((path: string) => {
    const el = fileRefs.current.get(path);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // Thread anchors live inside the rendered diffs. A pending jump first
  // reopens a collapsed file, then waits for its annotation to mount.
  const threadRefs = useRef<Map<number, HTMLElement>>(new Map());
  const [pendingThreadJump, setPendingThreadJump] = useState<{
    path: string;
    threadId: number;
  } | null>(null);
  const [focusedThreadId, setFocusedThreadId] = useState<number | null>(null);
  const registerThreadEl = useCallback((threadId: number, el: HTMLElement | null) => {
    if (el) threadRefs.current.set(threadId, el);
    else threadRefs.current.delete(threadId);
  }, []);
  const scrollToThread = useCallback((path: string, threadId: number) => {
    setCollapsedByFile((current) => {
      if (!current.has(path)) return current;
      const next = new Set(current);
      next.delete(path);
      return next;
    });
    setPendingThreadJump({ path, threadId });
  }, []);

  useEffect(() => {
    if (!pendingThreadJump || collapsedByFile.has(pendingThreadJump.path)) return;
    let frame = 0;
    let attempts = 0;
    const seek = () => {
      const el = threadRefs.current.get(pendingThreadJump.threadId);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.focus({ preventScroll: true });
        setFocusedThreadId(pendingThreadJump.threadId);
        setPendingThreadJump(null);
        return;
      }
      attempts += 1;
      if (attempts < 12) frame = requestAnimationFrame(seek);
      else setPendingThreadJump(null);
    };
    frame = requestAnimationFrame(seek);
    return () => cancelAnimationFrame(frame);
  }, [collapsedByFile, pendingThreadJump]);

  useEffect(() => {
    if (focusedThreadId == null) return;
    const timer = window.setTimeout(() => setFocusedThreadId(null), 1800);
    return () => window.clearTimeout(timer);
  }, [focusedThreadId]);

  const clearReview = useCallback(async () => {
    const ok = window.confirm(
      "Delete all threads, comments, and review history for this PR? The PR stays in the list so you can run a fresh review.",
    );
    if (!ok) return;
    await api.clearReview(id);
    setStream({ active: false, log: [], result: null, error: null });
    void load();
  }, [id, load]);

  const runReview = useCallback(async () => {
    setStream({ active: true, log: [], result: null, error: null });
    setShowLog(false);
    let result: StreamState["result"] = null;
    let error: string | null = null;
    try {
      // Flush the latest panel config so the run uses exactly what's on screen.
      if (reviewConfigRef.current) {
        await api.savePrReviewConfig(id, reviewConfigRef.current);
      }
      await postSse(`/api/prs/${id}/review`, {}, (ev) => {
        const data = ev.data as Record<string, unknown> | string | undefined;
        const pick = (key: string): string => {
          if (data && typeof data === "object" && key in data)
            return String((data as Record<string, unknown>)[key] ?? "");
          return "";
        };
        if (ev.event === "log") {
          setStream((s) => ({ ...s, log: [...s.log, pick("message")] }));
        } else if (ev.event === "stderr") {
          setStream((s) => ({ ...s, log: [...s.log, pick("data")] }));
        } else if (ev.event === "done") {
          const d = ev.data as { addedThreads: number; staleMarked: number };
          result = d;
        } else if (ev.event === "error") {
          error = pick("message") || "Review failed.";
        }
      });
    } catch (e) {
      error = (e as Error).message;
    } finally {
      setStream((s) => ({ ...s, active: false, result, error }));
      try {
        await loadReviewSnapshot();
      } catch (refreshError) {
        console.error(refreshError);
      }
      void load().catch(console.error);
    }
  }, [id, load, loadReviewSnapshot]);

  const switchReviewerProvider = useCallback(
    async (provider: string | null) => {
      setSavingProvider(true);
      try {
        const reviewerProvider = await api.setPrReviewerProvider(id, provider);
        setDetail((current) => (current ? { ...current, reviewerProvider } : current));
      } finally {
        setSavingProvider(false);
      }
    },
    [id],
  );

  if (!detail) return <div className="loading">Loading…</div>;

  const resolved = detail.threads.filter((t) => t.status === "resolved");
  const openCount = detail.threads.filter((t) => t.status === "open").length;
  const showEmptyBanner =
    !stream.active &&
    !stream.error &&
    openCount === 0 &&
    (stream.result?.addedThreads === 0 ||
      (detail.lastReview?.status === "done" && detail.threads.length === 0));

  const showAddedBanner =
    !stream.active && !stream.error && stream.result !== null && stream.result.addedThreads > 0;
  const persistedReviewError =
    detail.lastReview?.status === "error" && detail.lastReview.id !== dismissedReviewErrorId
      ? detail.lastReview.error || "Review failed."
      : null;
  const reviewError = stream.error ?? persistedReviewError;

  return (
    <div className="prview">
      <ReviewSettingsPanel
        prId={id}
        disabled={reviewActive}
        onConfigChange={(c) => {
          reviewConfigRef.current = c;
        }}
      />
      <header className="pr-header" ref={prHeaderRef}>
        <div className="pr-header-text">
          <Link to="/" className="back-link">
            ← All PRs
          </Link>
          <h1>
            #{detail.pr.number} {detail.pr.title}
          </h1>
          <div className="muted small">
            {detail.repo.owner}/{detail.repo.name} · {detail.pr.headRef} → {detail.pr.baseRef} ·{" "}
            {detail.pr.headSha.slice(0, 7)} ·{" "}
            <a href={detail.pr.url} target="_blank" rel="noreferrer">
              GitHub
            </a>
          </div>
        </div>
        <div className="spacer" />
        <div className="view-toggle" role="tablist" aria-label="Diff layout">
          <button
            role="tab"
            aria-selected={viewMode === "unified"}
            className={viewMode === "unified" ? "active" : ""}
            onClick={() => setViewMode("unified")}
          >
            Unified
          </button>
          <button
            role="tab"
            aria-selected={viewMode === "split"}
            className={viewMode === "split" ? "active" : ""}
            onClick={() => setViewMode("split")}
          >
            Split
          </button>
        </div>
        <label className="pr-provider-picker">
          <span className="muted small">Reviewer</span>
          <select
            className="reviewer-provider-select"
            value={detail.reviewerProvider.override ?? ""}
            disabled={reviewActive || savingProvider}
            onChange={(e) => void switchReviewerProvider(e.target.value || null)}
          >
            <option value="">
              Use {detail.reviewerProvider.repoOverride ? "repo" : "global"} default (
              {detail.reviewerProviders.find(
                (p) =>
                  p.id === (detail.reviewerProvider.repoOverride ?? detail.reviewerProvider.global),
              )?.displayName ??
                detail.reviewerProvider.repoOverride ??
                detail.reviewerProvider.global}
              )
            </option>
            {detail.reviewerProviders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
        </label>
        {detail.threads.length > 0 && (
          <button className="btn" onClick={clearReview} disabled={reviewActive}>
            Clear review
          </button>
        )}
        <button
          className={`btn primary review-btn ${reviewActive ? "is-running" : ""}`}
          onClick={runReview}
          disabled={reviewActive}
        >
          {reviewActive && <span className="btn-spinner" aria-hidden />}
          {reviewActive ? "Reviewing…" : detail.threads.length ? "Re-run review" : "Run review"}
        </button>
      </header>

      <div className={`pr-body-grid ${sidenavCollapsed ? "sidenav-closed" : ""}`}>
        <aside className="pr-sidenav">
          {sidenavCollapsed ? (
            <button
              type="button"
              className="sidenav-stub"
              onClick={toggleSidenav}
              title="Show files panel"
              aria-label="Show files panel"
            >
              <span aria-hidden>›</span>
            </button>
          ) : (
            <SideNav
              files={sortedFiles}
              threadsByFile={threadsByFile}
              viewedSet={viewedSet}
              onJump={scrollToFile}
              onThreadJump={scrollToThread}
              onCollapse={toggleSidenav}
            />
          )}
        </aside>

        <div className="pr-main">
          {reviewActive && (
            <ReviewProgress
              log={stream.log}
              showLog={showLog}
              onToggleLog={() => setShowLog((v) => !v)}
            />
          )}
          {reviewError && !reviewActive && (
            <ReviewError
              message={reviewError}
              onDismiss={() => {
                setStream((s) => ({ ...s, error: null }));
                if (detail.lastReview?.status === "error") {
                  setDismissedReviewErrorId(detail.lastReview.id);
                }
              }}
            />
          )}
          {showAddedBanner && (
            <AddedBanner
              addedThreads={stream.result!.addedThreads}
              staleMarked={stream.result!.staleMarked}
              summary={detail.summaryReview?.summary ?? null}
              onDismiss={() => setStream((s) => ({ ...s, result: null }))}
            />
          )}
          {showEmptyBanner && (
            <NoIssuesBanner
              lastReview={detail.lastReview}
              summary={detail.summaryReview?.summary ?? null}
            />
          )}
          {!reviewActive &&
            !showAddedBanner &&
            !showEmptyBanner &&
            detail.summaryReview?.summary.trim() && (
              <ReviewSummaryBanner review={detail.summaryReview} />
            )}

          {detail.pr.body && <CollapsiblePrBody body={detail.pr.body} />}

          {prLevel.length > 0 && (
            <section className="pr-level-threads">
              <h3>PR-level threads</h3>
              {prLevel.map((t) => (
                <ThreadCard key={t.id} thread={t} repoId={detail.repo.id} onChange={load} />
              ))}
            </section>
          )}

          {orphanThreads.length > 0 && (
            <section className="pr-level-threads">
              <h3>Comments outside the diff</h3>
              <p className="muted small">
                These reference files or lines not present in this diff, so they can't be anchored
                inline.
              </p>
              {orphanThreads.map((t) => (
                <ThreadCard
                  key={t.id}
                  thread={t}
                  repoId={detail.repo.id}
                  onChange={load}
                  showAnchor
                />
              ))}
            </section>
          )}

          <section className="diff">
            {sortedFiles.map((f) => (
              <FileBlock
                key={f.path}
                file={f}
                repoId={detail.repo.id}
                registerRef={registerFileEl}
                registerThreadRef={registerThreadEl}
                annotations={annByFile.get(f.path) ?? []}
                fileThreads={fileLevelByFile.get(f.path) ?? []}
                allThreads={threadsByFile.get(f.path) ?? []}
                themeType={themeType}
                viewMode={viewMode}
                viewed={viewedSet.has(f.path)}
                onToggleViewed={(v) => void setViewed(f.path, v)}
                collapsed={collapsedByFile.has(f.path)}
                onToggleCollapsed={() => toggleCollapsed(f.path)}
                onChange={load}
                focusedThreadId={focusedThreadId}
              />
            ))}
          </section>

          {resolved.length > 0 && (
            <section className="resolved-section">
              <h3>Resolved ({resolved.length})</h3>
              {resolved.map((t) => (
                <ThreadCard key={t.id} thread={t} repoId={detail.repo.id} onChange={load} compact />
              ))}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

const PIERRE_THEME = { dark: "pierre-dark", light: "pierre-light" } as const;

// The diff renders inside @pierre/diffs' shadow DOM, so our stylesheet can't
// reach the sticky file header (it ships `top: 0`, which tucks the header
// under our sticky topbar + PR header). `unsafeCSS` is injected into the
// shadow root's highest cascade layer, so this override wins. 124px matches
// the files sidenav offset (56px topbar + the sticky PR header).
const STICKY_HEADER_CSS = "[data-diffs-header][data-sticky]{top:var(--diff-sticky-top,124px)}";

function topOpenSeverity(threads: Thread[]): { rank: number; severity: string | null } {
  let rank = NO_SEVERITY_RANK;
  let severity: string | null = null;
  for (const t of threads) {
    if (t.status !== "open") continue;
    const r = SEVERITY_RANK[t.severity ?? "concern"] ?? SEVERITY_RANK.concern!;
    if (r < rank) {
      rank = r;
      severity = t.severity ?? "concern";
    }
  }
  return { rank, severity };
}

function SideNav({
  files,
  threadsByFile,
  viewedSet,
  onJump,
  onThreadJump,
  onCollapse,
}: {
  files: PatchFile[];
  threadsByFile: Map<string, Thread[]>;
  viewedSet: Set<string>;
  onJump: (path: string) => void;
  onThreadJump: (path: string, threadId: number) => void;
  onCollapse: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const matches = filter.trim().toLowerCase();
  const visible = matches ? files.filter((f) => f.path.toLowerCase().includes(matches)) : files;
  return (
    <div className="sidenav-inner">
      <div className="sidenav-header">
        <div className="sidenav-title-row">
          <h3>Files ({files.length})</h3>
          <button
            type="button"
            className="sidenav-collapse"
            onClick={onCollapse}
            title="Hide files panel"
            aria-label="Hide files panel"
          >
            ‹
          </button>
        </div>
        <input
          className="sidenav-filter"
          type="text"
          placeholder="Filter files…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <ul className="sidenav-list">
        {visible.map((f) => {
          const threads = threadsByFile.get(f.path) ?? [];
          const stats = statsForThreads(threads);
          const sev = topOpenSeverity(threads).severity;
          const viewed = viewedSet.has(f.path);
          const expanded = expandedFiles.has(f.path);
          return (
            <li key={f.path}>
              <div className="sidenav-file-line">
                {threads.length > 0 ? (
                  <button
                    type="button"
                    className="sidenav-thread-toggle"
                    onClick={() =>
                      setExpandedFiles((current) => {
                        const next = new Set(current);
                        if (next.has(f.path)) next.delete(f.path);
                        else next.add(f.path);
                        return next;
                      })
                    }
                    aria-expanded={expanded}
                    aria-label={`${expanded ? "Hide" : "Show"} comments for ${f.path}`}
                  >
                    {expanded ? "▾" : "▸"}
                  </button>
                ) : (
                  <span className="sidenav-thread-toggle-spacer" aria-hidden />
                )}
                <button
                  className={`sidenav-row ${viewed ? "viewed" : ""}`}
                  onClick={() => onJump(f.path)}
                  title={f.path}
                >
                  <span className={`sev-dot ${sev ? `sev-${sev}` : "none"}`} aria-hidden />
                  <span className="sidenav-path">{f.path}</span>
                  <span className="sidenav-counts">
                    {stats.openCount > 0 && (
                      <span className="pill open" title={`${stats.openCount} open`}>
                        {stats.openCount}
                      </span>
                    )}
                    {stats.resolvedCount > 0 && (
                      <span className="pill ok" title={`${stats.resolvedCount} resolved`}>
                        {stats.resolvedCount}
                      </span>
                    )}
                    {viewed && (
                      <span className="check" aria-hidden>
                        ✓
                      </span>
                    )}
                  </span>
                </button>
              </div>
              {expanded && threads.length > 0 && (
                <ul className="sidenav-thread-list">
                  {threads.map((thread) => (
                    <li key={thread.id}>
                      <button
                        type="button"
                        className={`sidenav-thread-row ${thread.status}`}
                        onClick={() => onThreadJump(f.path, thread.id)}
                        title={thread.comments[0]?.body ?? "Review comment"}
                      >
                        <span
                          className={`sev-dot ${thread.severity ? `sev-${thread.severity}` : "none"}`}
                          aria-hidden
                        />
                        <span className="sidenav-thread-copy">
                          <span className="sidenav-thread-location mono">
                            {thread.line == null ? "File" : `L${thread.line}`}
                          </span>
                          <span className="sidenav-thread-preview">{threadPreview(thread)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
        {visible.length === 0 && <li className="muted small">No files match.</li>}
      </ul>
    </div>
  );
}

function threadPreview(thread: Thread): string {
  const body = thread.comments[0]?.body ?? "Review comment";
  const plain = body
    .replace(/```[\s\S]*?```/g, " code ")
    .replace(/[`*_#>()]/g, "")
    .replaceAll("[", "")
    .replaceAll("]", "")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(plain || "Review comment", 68);
}

function ReviewProgress({
  log,
  showLog,
  onToggleLog,
}: {
  log: string[];
  showLog: boolean;
  onToggleLog: () => void;
}) {
  const lastLine = log[log.length - 1] ?? "";
  return (
    <div className="review-progress" role="status" aria-live="polite">
      <span className="pulse" aria-hidden />
      <div className="review-progress-text">
        <strong>Reviewing…</strong>
        {lastLine && <span className="muted small mono">{truncate(lastLine, 120)}</span>}
      </div>
      <div className="spacer" />
      {log.length > 0 && (
        <button type="button" className="btn small ghost" onClick={onToggleLog}>
          {showLog ? "Hide log" : "Show log"}
        </button>
      )}
      {showLog && (
        <pre className="review-progress-log" aria-hidden={!showLog}>
          {log.join("\n")}
        </pre>
      )}
    </div>
  );
}

function ReviewError({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="review-error" role="alert">
      <span className="review-error-glyph" aria-hidden>
        !
      </span>
      <div className="review-error-text">
        <strong>Review failed.</strong>
        <pre className="review-error-message">{message}</pre>
      </div>
      <div className="spacer" />
      <button type="button" className="btn small ghost" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

function ReviewSummary({ summary }: { summary: string | null | undefined }) {
  if (!summary?.trim()) return null;
  return (
    <div className="banner-summary">
      <Markdown>{summary}</Markdown>
    </div>
  );
}

function ReviewSummaryBanner({ review }: { review: NonNullable<PRDetail["summaryReview"]> }) {
  const when = review.finishedAt ? new Date(review.finishedAt).toLocaleString() : "earlier";
  return (
    <section className="review-summary-banner" aria-label="Review summary">
      <div className="banner-row">
        <span className="review-summary-glyph" aria-hidden>
          i
        </span>
        <div>
          <strong>Review summary</strong>
          <div className="muted small">
            Ran {when} on {review.headSha.slice(0, 7)} via {review.provider}.
          </div>
        </div>
      </div>
      <ReviewSummary summary={review.summary} />
    </section>
  );
}

function AddedBanner({
  addedThreads,
  staleMarked,
  summary,
  onDismiss,
}: {
  addedThreads: number;
  staleMarked: number;
  summary: string | null;
  onDismiss: () => void;
}) {
  const stalePart =
    staleMarked > 0 ? `, ${staleMarked} thread${staleMarked === 1 ? "" : "s"} marked stale` : "";
  return (
    <div className="added-banner" role="status">
      <div className="banner-row">
        <span className="added-banner-glyph" aria-hidden>
          +
        </span>
        <div>
          <strong>Review complete.</strong>
          <div className="muted small">
            Added {addedThreads} comment{addedThreads === 1 ? "" : "s"}
            {stalePart}.
          </div>
        </div>
        <div className="spacer" />
        <button type="button" className="btn small ghost" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
      <ReviewSummary summary={summary} />
    </div>
  );
}

function NoIssuesBanner({
  lastReview,
  summary,
}: {
  lastReview: PRDetail["lastReview"];
  summary: string | null;
}) {
  const when = lastReview?.finishedAt
    ? new Date(lastReview.finishedAt).toLocaleString()
    : "earlier";
  return (
    <div className="no-issues-banner" role="status">
      <div className="banner-row">
        <span className="no-issues-glyph" aria-hidden>
          ✓
        </span>
        <div>
          <strong>No issues found.</strong>
          <div className="muted small">
            {lastReview
              ? `Last review ran ${when} on ${lastReview.headSha.slice(0, 7)} via ${lastReview.provider}.`
              : "No review has been recorded yet."}
          </div>
        </div>
      </div>
      <ReviewSummary summary={summary} />
    </div>
  );
}

function CollapsiblePrBody({ body }: { body: string }) {
  const long = body.length > BODY_PEEK_CHARS;
  const [open, setOpen] = useState(false);
  if (!long) {
    return (
      <section className="pr-body">
        <Markdown>{body}</Markdown>
      </section>
    );
  }
  return (
    <section className={`pr-body collapsible ${open ? "open" : "closed"}`}>
      <div className="pr-body-content">
        <Markdown>{body}</Markdown>
      </div>
      <button className="pr-body-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? "Collapse description" : "Expand description"}
      </button>
    </section>
  );
}

function FileBlock({
  file,
  repoId,
  registerRef,
  registerThreadRef,
  annotations,
  fileThreads,
  allThreads,
  themeType,
  viewMode,
  viewed,
  onToggleViewed,
  collapsed,
  onToggleCollapsed,
  onChange,
  focusedThreadId,
}: {
  file: PatchFile;
  repoId: number;
  registerRef: (path: string, el: HTMLElement | null) => void;
  registerThreadRef: (threadId: number, el: HTMLElement | null) => void;
  annotations: LineThreads[];
  fileThreads: Thread[];
  allThreads: Thread[];
  themeType: Theme;
  viewMode: ViewMode;
  viewed: boolean;
  onToggleViewed: (next: boolean) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onChange: () => void;
  focusedThreadId: number | null;
}) {
  const stats = statsForThreads(allThreads);
  const sev = topOpenSeverity(allThreads).severity;

  // Pierre renders this slot on the left side of its file header. We use it
  // to host the fold chevron and the severity dot so all per-file controls
  // share one row.
  const renderHeaderPrefix = useCallback(
    () => (
      <span className="file-header-prefix">
        <button
          type="button"
          className="file-fold"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand file" : "Collapse file"}
        >
          <span className={`chevron ${collapsed ? "right" : "down"}`} aria-hidden>
            ▾
          </span>
        </button>
        <span className={`sev-dot ${sev ? `sev-${sev}` : "none"}`} aria-hidden />
      </span>
    ),
    [collapsed, onToggleCollapsed, sev],
  );

  // Pierre renders this slot on the right side of its file header — perfect
  // for counts plus the Viewed checkbox.
  const renderHeaderMetadata = useCallback(
    () => (
      <span className="file-header-metadata">
        {stats.openCount > 0 && <span className="pill open">{stats.openCount} open</span>}
        {stats.resolvedCount > 0 && <span className="pill ok">{stats.resolvedCount} resolved</span>}
        <label
          className="viewed-toggle"
          title="Mark this file as viewed (auto-collapses)"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={viewed}
            onChange={(e) => onToggleViewed(e.target.checked)}
          />
          <span>Viewed</span>
        </label>
      </span>
    ),
    [stats.openCount, stats.resolvedCount, viewed, onToggleViewed],
  );

  return (
    <article
      className={`file-block ${collapsed ? "collapsed" : ""} ${viewed ? "viewed" : ""}`}
      ref={(el) => registerRef(file.path, el)}
    >
      {fileThreads.length > 0 && !collapsed && (
        <div className="file-threads">
          {fileThreads.map((t) => (
            <ThreadCard
              key={t.id}
              thread={t}
              repoId={repoId}
              onChange={onChange}
              showAnchor={t.line != null}
              registerRef={registerThreadRef}
              focused={focusedThreadId === t.id}
            />
          ))}
        </div>
      )}
      <PatchDiff<Thread[]>
        patch={file.patch}
        className="pierre-diff"
        options={{
          theme: PIERRE_THEME,
          themeType,
          diffStyle: viewMode,
          diffIndicators: "bars",
          lineDiffType: "word",
          overflow: "wrap",
          stickyHeader: true,
          unsafeCSS: STICKY_HEADER_CSS,
          collapsed,
        }}
        lineAnnotations={annotations}
        renderHeaderPrefix={renderHeaderPrefix}
        renderHeaderMetadata={renderHeaderMetadata}
        renderAnnotation={(a) => (
          <div className="pierre-annotation">
            {a.metadata.map((t) => (
              <ThreadCard
                key={t.id}
                thread={t}
                repoId={repoId}
                onChange={onChange}
                registerRef={registerThreadRef}
                focused={focusedThreadId === t.id}
              />
            ))}
          </div>
        )}
      />
    </article>
  );
}

function ThreadCard({
  thread,
  repoId,
  onChange,
  compact = false,
  showAnchor = false,
  registerRef,
  focused = false,
}: {
  thread: Thread;
  repoId: number;
  onChange: () => void;
  compact?: boolean;
  showAnchor?: boolean;
  registerRef?: (threadId: number, el: HTMLElement | null) => void;
  focused?: boolean;
}) {
  const [reply, setReply] = useState("");
  const [streaming, setStreaming] = useState<null | "reply" | "revalidate">(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function sendReply() {
    if (!reply.trim()) return;
    setStreaming("reply");
    setActionError(null);
    try {
      await postSse(`/api/threads/${thread.id}/messages`, { body: reply }, () => {});
      setReply("");
      onChange();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      if (errorHasPersistedInput(error)) setReply("");
      onChange();
    } finally {
      setStreaming(null);
    }
  }

  async function revalidate() {
    setStreaming("revalidate");
    setActionError(null);
    try {
      await postSse(`/api/threads/${thread.id}/revalidate`, {}, () => {});
      onChange();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setStreaming(null);
    }
  }

  async function toggleStatus() {
    await api.setStatus(thread.id, thread.status === "open" ? "resolved" : "open");
    onChange();
  }

  const sevClass = thread.severity ? `sev-${thread.severity}` : "";
  return (
    <div
      className={`thread ${sevClass} ${thread.status} ${compact ? "compact" : ""} ${focused ? "jump-target" : ""}`}
      ref={(el) => registerRef?.(thread.id, el)}
      tabIndex={-1}
    >
      <div className="thread-meta">
        {thread.severity && <span className={`pill sev ${sevClass}`}>{thread.severity}</span>}
        {showAnchor && thread.filePath && (
          <span className="thread-anchor mono small" title={thread.filePath}>
            {thread.filePath.split("/").pop()}
            {thread.line != null ? `:${thread.line}` : ""}
          </span>
        )}
        {thread.stale && <span className="pill warn">stale</span>}
        {thread.status === "resolved" && <span className="pill ok">resolved</span>}
        <div className="spacer" />
        <button className="btn small" onClick={revalidate} disabled={streaming !== null}>
          {streaming === "revalidate" && <span className="btn-spinner" aria-hidden />}
          {streaming === "revalidate" ? "Revalidating…" : "Revalidate"}
        </button>
        <button className="btn small" onClick={toggleStatus}>
          {thread.status === "open" ? "Mark resolved" : "Reopen"}
        </button>
      </div>
      <div className="thread-comments">
        {thread.comments.map((c) => (
          <CommentBlock key={c.id} comment={c} repoId={repoId} />
        ))}
      </div>
      {thread.status === "open" && (
        <div className="thread-reply">
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Reply to the reviewer…"
            disabled={streaming !== null}
          />
          <button
            className="btn primary small"
            onClick={sendReply}
            disabled={streaming !== null || !reply.trim()}
          >
            {streaming === "reply" ? "…" : "Send"}
          </button>
        </div>
      )}
      {actionError && (
        <div role="alert" className="small thread-action-error">
          {actionError}
        </div>
      )}
    </div>
  );
}

function appendRule(existing: string, snippet: string): string {
  const base = existing.trim();
  const add = snippet.trim();
  return base ? `${base}\n\n${add}` : add;
}

type RuleState = "idle" | "choosing" | "saving" | "saved";

function CommentBlock({
  comment: c,
  repoId,
}: {
  comment: Thread["comments"][number];
  repoId: number;
}) {
  const [copied, setCopied] = useState(false);
  const [ruleState, setRuleState] = useState<RuleState>("idle");
  const isAi = c.author === "ai";
  async function copy() {
    try {
      await navigator.clipboard.writeText(c.body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error("clipboard write failed", e);
    }
  }
  async function saveAsRule(scope: "global" | "repo") {
    setRuleState("saving");
    try {
      if (scope === "repo") {
        const { body } = await api.skills(repoId);
        await api.saveSkills(repoId, appendRule(body, c.body));
      } else {
        const g = await api.globalReviewConfig();
        await api.saveGlobalReviewConfig({ customRules: appendRule(g.customRules, c.body) });
      }
      setRuleState("saved");
      setTimeout(() => setRuleState("idle"), 1800);
    } catch (e) {
      console.error("save as rule failed", e);
      setRuleState("idle");
    }
  }
  return (
    <div className={`comment ${c.author} ${c.kind}`}>
      <div className="comment-header">
        <span className="comment-author">
          {isAi ? "AI" : "you"}
          {c.kind !== "normal" ? ` · ${c.kind}` : ""}
        </span>
        {isAi && (
          <span className="comment-actions">
            {ruleState === "idle" && (
              <button
                type="button"
                className="comment-action"
                onClick={() => setRuleState("choosing")}
                title="Save this finding as a reviewer rule (never written to the repo)"
              >
                Save as rule
              </button>
            )}
            {ruleState === "choosing" && (
              <span className="rule-scope">
                <span className="muted small">Save to</span>
                <button
                  type="button"
                  className="comment-action"
                  onClick={() => void saveAsRule("global")}
                >
                  Global
                </button>
                <button
                  type="button"
                  className="comment-action"
                  onClick={() => void saveAsRule("repo")}
                >
                  This repo
                </button>
                <button
                  type="button"
                  className="comment-action ghost"
                  onClick={() => setRuleState("idle")}
                >
                  Cancel
                </button>
              </span>
            )}
            {ruleState === "saving" && <span className="muted small">Saving…</span>}
            {ruleState === "saved" && <span className="ok small">Saved as rule ✓</span>}
            <button
              type="button"
              className="comment-copy"
              onClick={copy}
              title="Copy raw markdown of this comment"
              aria-label="Copy comment markdown"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </span>
        )}
      </div>
      <div className="comment-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{c.body}</ReactMarkdown>
      </div>
    </div>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
