import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PatchDiff, type DiffLineAnnotation } from "@pierre/diffs/react";
import { api, postSse, type PRDetail, type Thread } from "../api.js";
import { ReviewSettingsPanel } from "../components/ReviewSettingsPanel.js";
import type { ReviewConfigFields } from "../components/ReviewConfigEditor.js";
import { splitPatchByFile, type PatchFile } from "../diff.js";
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
  const [diff, setDiff] = useState<string>("");
  const [stream, setStream] = useState<StreamState>({
    active: false,
    log: [],
    result: null,
    error: null,
  });
  const [showLog, setShowLog] = useState(false);
  const reviewConfigRef = useRef<ReviewConfigFields | null>(null);

  const load = useCallback(async () => {
    const [d, df] = await Promise.all([api.pr(id), api.diff(id)]);
    setDetail(d);
    setDiff(df);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const files = useMemo<PatchFile[]>(() => (diff ? splitPatchByFile(diff) : []), [diff]);

  // Index threads by file (inline = anchored to a line; file-level = no line).
  const { threadsByFile, inlineByFile, fileLevelByFile, prLevel } = useMemo(() => {
    const threadsByFile = new Map<string, Thread[]>();
    const inlineByFile = new Map<string, Map<string, Thread[]>>();
    const fileLevelByFile = new Map<string, Thread[]>();
    const prLevel: Thread[] = [];
    if (!detail) return { threadsByFile, inlineByFile, fileLevelByFile, prLevel };
    for (const t of detail.threads) {
      if (!t.filePath) {
        prLevel.push(t);
        continue;
      }
      const all = threadsByFile.get(t.filePath) ?? [];
      all.push(t);
      threadsByFile.set(t.filePath, all);
      if (t.line == null) {
        const arr = fileLevelByFile.get(t.filePath) ?? [];
        arr.push(t);
        fileLevelByFile.set(t.filePath, arr);
        continue;
      }
      const side = t.side === "LEFT" ? "deletions" : "additions";
      const byLine = inlineByFile.get(t.filePath) ?? new Map<string, Thread[]>();
      const key = `${t.line}:${side}`;
      const arr = byLine.get(key) ?? [];
      arr.push(t);
      byLine.set(key, arr);
      inlineByFile.set(t.filePath, byLine);
    }
    return { threadsByFile, inlineByFile, fileLevelByFile, prLevel };
  }, [detail]);

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
      void load();
    }
  }, [id, load]);

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

  return (
    <div className="prview">
      <ReviewSettingsPanel
        prId={id}
        disabled={stream.active}
        onConfigChange={(c) => {
          reviewConfigRef.current = c;
        }}
      />
      <header className="pr-header">
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
        {detail.threads.length > 0 && (
          <button className="btn" onClick={clearReview} disabled={stream.active}>
            Clear review
          </button>
        )}
        <button
          className={`btn primary review-btn ${stream.active ? "is-running" : ""}`}
          onClick={runReview}
          disabled={stream.active}
        >
          {stream.active && <span className="btn-spinner" aria-hidden />}
          {stream.active ? "Reviewing…" : detail.threads.length ? "Re-run review" : "Run review"}
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
              onCollapse={toggleSidenav}
            />
          )}
        </aside>

        <div className="pr-main">
          {stream.active && (
            <ReviewProgress
              log={stream.log}
              showLog={showLog}
              onToggleLog={() => setShowLog((v) => !v)}
            />
          )}
          {stream.error && !stream.active && (
            <ReviewError
              message={stream.error}
              onDismiss={() => setStream((s) => ({ ...s, error: null }))}
            />
          )}
          {showAddedBanner && (
            <AddedBanner
              addedThreads={stream.result!.addedThreads}
              staleMarked={stream.result!.staleMarked}
              onDismiss={() => setStream((s) => ({ ...s, result: null }))}
            />
          )}
          {showEmptyBanner && <NoIssuesBanner lastReview={detail.lastReview} />}

          {detail.pr.body && <CollapsiblePrBody body={detail.pr.body} />}

          {prLevel.length > 0 && (
            <section className="pr-level-threads">
              <h3>PR-level threads</h3>
              {prLevel.map((t) => (
                <ThreadCard key={t.id} thread={t} repoId={detail.repo.id} onChange={load} />
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
  onCollapse,
}: {
  files: PatchFile[];
  threadsByFile: Map<string, Thread[]>;
  viewedSet: Set<string>;
  onJump: (path: string) => void;
  onCollapse: () => void;
}) {
  const [filter, setFilter] = useState("");
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
          return (
            <li key={f.path}>
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
            </li>
          );
        })}
        {visible.length === 0 && <li className="muted small">No files match.</li>}
      </ul>
    </div>
  );
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
        <div className="muted small">{message}</div>
      </div>
      <div className="spacer" />
      <button type="button" className="btn small ghost" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

function AddedBanner({
  addedThreads,
  staleMarked,
  onDismiss,
}: {
  addedThreads: number;
  staleMarked: number;
  onDismiss: () => void;
}) {
  const stalePart =
    staleMarked > 0 ? `, ${staleMarked} thread${staleMarked === 1 ? "" : "s"} marked stale` : "";
  return (
    <div className="added-banner" role="status">
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
  );
}

function NoIssuesBanner({ lastReview }: { lastReview: PRDetail["lastReview"] }) {
  const when = lastReview?.finishedAt
    ? new Date(lastReview.finishedAt).toLocaleString()
    : "earlier";
  return (
    <div className="no-issues-banner" role="status">
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
  );
}

function CollapsiblePrBody({ body }: { body: string }) {
  const long = body.length > BODY_PEEK_CHARS;
  const [open, setOpen] = useState(false);
  if (!long) {
    return (
      <section className="pr-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
      </section>
    );
  }
  return (
    <section className={`pr-body collapsible ${open ? "open" : "closed"}`}>
      <div className="pr-body-content">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
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
}: {
  file: PatchFile;
  repoId: number;
  registerRef: (path: string, el: HTMLElement | null) => void;
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
            <ThreadCard key={t.id} thread={t} repoId={repoId} onChange={onChange} />
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
          collapsed,
        }}
        lineAnnotations={annotations}
        renderHeaderPrefix={renderHeaderPrefix}
        renderHeaderMetadata={renderHeaderMetadata}
        renderAnnotation={(a) => (
          <div className="pierre-annotation">
            {a.metadata.map((t) => (
              <ThreadCard key={t.id} thread={t} repoId={repoId} onChange={onChange} />
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
}: {
  thread: Thread;
  repoId: number;
  onChange: () => void;
  compact?: boolean;
}) {
  const [reply, setReply] = useState("");
  const [streaming, setStreaming] = useState<null | "reply" | "revalidate">(null);

  async function sendReply() {
    if (!reply.trim()) return;
    setStreaming("reply");
    try {
      await postSse(`/api/threads/${thread.id}/messages`, { body: reply }, () => {});
      setReply("");
      onChange();
    } finally {
      setStreaming(null);
    }
  }

  async function revalidate() {
    setStreaming("revalidate");
    try {
      await postSse(`/api/threads/${thread.id}/revalidate`, {}, () => {});
      onChange();
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
    <div className={`thread ${sevClass} ${thread.status} ${compact ? "compact" : ""}`}>
      <div className="thread-meta">
        {thread.severity && <span className={`pill sev ${sevClass}`}>{thread.severity}</span>}
        {thread.stale && <span className="pill warn">stale</span>}
        {thread.status === "resolved" && <span className="pill ok">resolved</span>}
        <div className="spacer" />
        <button className="btn small" onClick={revalidate} disabled={streaming !== null}>
          {streaming === "revalidate" ? "…" : "Revalidate"}
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
