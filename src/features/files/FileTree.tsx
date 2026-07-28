import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  openFileFromTree,
  openWorkspacePath,
} from "@/features/shell/orchestrate";
import {
  useWorkspaceStore,
  type TreeNode,
} from "@/features/workspace/workspaceStore";
import { pathMatchesExclude } from "@/core/workspace/pathFilter";
import { joinPath } from "@/core/workspace/paths";
import { Icon } from "@/shared/Icon";
import type { CodiconName } from "@/shared/Icon";

type SearchHit = { path: string; line: number; text: string };

type SearchFileGroup = {
  path: string;
  hits: SearchHit[];
};

/** Group hits by file path (preserve first-seen order). */
function groupHitsByFile(hits: SearchHit[]): SearchFileGroup[] {
  const map = new Map<string, SearchHit[]>();
  const order: string[] = [];
  for (const hit of hits) {
    const list = map.get(hit.path);
    if (!list) {
      map.set(hit.path, [hit]);
      order.push(hit.path);
    } else {
      list.push(hit);
    }
  }
  return order.map((path) => ({ path, hits: map.get(path)! }));
}

/** Collapse noisy whitespace for preview rows. */
function previewLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Highlight the first match of query in a line (fixed or simple regex). */
function highlightPreview(
  text: string,
  query: string,
  useRegex: boolean,
  caseSensitive: boolean,
): ReactNode {
  const line = previewLine(text);
  if (!query.trim() || !line) return line;
  try {
    let re: RegExp;
    if (useRegex) {
      re = new RegExp(query, caseSensitive ? "" : "i");
    } else {
      const esc = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      re = new RegExp(esc, caseSensitive ? "" : "i");
    }
    const m = line.match(re);
    if (!m || m.index === undefined || m[0] === "") return line;
    const i = m.index;
    const end = i + m[0].length;
    return (
      <>
        {line.slice(0, i)}
        <mark className="files-search-hit__mark">{line.slice(i, end)}</mark>
        {line.slice(end)}
      </>
    );
  } catch {
    return line;
  }
}

export function FileTree() {
  const workspaceRoot = useWorkspaceStore((s) => s.workspaceRoot);
  const workspaceName = useWorkspaceStore((s) => s.workspaceName);
  const rootEntries = useWorkspaceStore((s) => s.rootEntries);
  const status = useWorkspaceStore((s) => s.status);
  const error = useWorkspaceStore((s) => s.error);
  const selectedPath = useWorkspaceStore((s) => s.selectedPath);
  const recent = useWorkspaceStore((s) => s.recent);
  const toggleDir = useWorkspaceStore((s) => s.toggleDir);
  const workspaceExcludes = useWorkspaceStore((s) => s.excludes);
  const addExclude = useWorkspaceStore((s) => s.addExclude);
  const removeExclude = useWorkspaceStore((s) => s.removeExclude);
  const addExcludePattern = useWorkspaceStore((s) => s.addExcludePattern);

  const [query, setQuery] = useState("");
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [workspaceFilterOpen, setWorkspaceFilterOpen] = useState(false);
  const [excludeDraft, setExcludeDraft] = useState("");
  const [treeMenu, setTreeMenu] = useState<{
    path: string;
    name: string;
    type: "file" | "dir";
    x: number;
    y: number;
  } | null>(null);
  const treeMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!treeMenu) return;
    const close = () => setTreeMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onDown = (e: MouseEvent) => {
      if (treeMenuRef.current?.contains(e.target as Node)) return;
      close();
    };
    // Defer so the opening contextmenu event doesn't immediately close.
    const t = window.setTimeout(() => {
      document.addEventListener("mousedown", onDown);
      document.addEventListener("keydown", onKey);
      window.addEventListener("blur", close);
      window.addEventListener("resize", close);
      window.addEventListener("scroll", close, true);
    }, 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [treeMenu]);

  const openTreeMenu = useCallback(
    (
      e: ReactMouseEvent,
      node: { path: string; name: string; type: "file" | "dir" },
    ) => {
      e.preventDefault();
      e.stopPropagation();
      const pad = 4;
      const menuW = 200;
      const menuH = 40;
      const x = Math.min(e.clientX, window.innerWidth - menuW - pad);
      const y = Math.min(e.clientY, window.innerHeight - menuH - pad);
      setTreeMenu({
        path: node.path,
        name: node.name,
        type: node.type,
        x: Math.max(pad, x),
        y: Math.max(pad, y),
      });
    },
    [],
  );
  /** Collapse search results list; file tree stays visible either way. */
  const [resultsOpen, setResultsOpen] = useState(true);
  /** Collapsed file groups: only the filename head is shown (no match lines). */
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(
    () => new Set(),
  );
  /** Results panel height (px); drag the RESULTS/EXPLORER divider to change. */
  const [resultsHeight, setResultsHeight] = useState(() => {
    try {
      const raw = localStorage.getItem("anchor.filesSearchResultsHeight");
      const n = raw ? Number.parseInt(raw, 10) : NaN;
      if (Number.isFinite(n) && n >= 120 && n <= 900) return n;
    } catch {
      // ignore
    }
    return 320;
  });
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [searchSource, setSearchSource] = useState<string | null>(null);
  const searchGen = useRef(0);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const resizeDrag = useRef<{ startY: number; startH: number } | null>(null);
  const resultsHeightRef = useRef(resultsHeight);
  resultsHeightRef.current = resultsHeight;

  const runSearch = useCallback(
    async (
      raw: string,
      opts: {
        include: string;
        exclude: string;
        useRegex: boolean;
        caseSensitive: boolean;
        workspaceExcludes: string[];
      },
    ) => {
      const q = raw.trim();
      const gen = ++searchGen.current;
      if (!workspaceRoot || q.length < 1) {
        setHits([]);
        setTruncated(false);
        setSearchError(null);
        setSearching(false);
        setSearchSource(null);
        return;
      }
      // Fixed-string: require 2 chars; regex may be short (e.g. `\d`)
      if (!opts.useRegex && q.length < 2) {
        setHits([]);
        setTruncated(false);
        setSearchError(null);
        setSearching(false);
        setSearchSource(null);
        return;
      }
      setSearching(true);
      setSearchError(null);
      // Clear previous results immediately so streaming replaces, not appends.
      setHits([]);
      setTruncated(false);
      setSearchSource(null);
      setCollapsedFiles(new Set());

      const requestId = `ui-${gen}-${Date.now()}`;
      const maxResults = 200;
      // Batch streamed hits onto animation frames (feel like VS Code progressive UI).
      let pending: SearchHit[] = [];
      let raf = 0;
      const flushPending = () => {
        raf = 0;
        if (gen !== searchGen.current || pending.length === 0) {
          pending = [];
          return;
        }
        const batch = pending;
        pending = [];
        setHits((prev) => {
          if (prev.length >= maxResults) return prev;
          const next = [...prev, ...batch];
          return next.length > maxResults ? next.slice(0, maxResults) : next;
        });
      };

      const offHits = window.anchor.workspace.onSearchHits?.((payload) => {
        if (payload.requestId !== requestId) return;
        if (gen !== searchGen.current) return;
        for (const h of payload.hits) {
          if (
            opts.workspaceExcludes.length > 0 &&
            pathMatchesExclude(h.path, opts.workspaceExcludes)
          ) {
            continue;
          }
          pending.push(h);
        }
        if (pending.length > 0 && !raf) {
          raf = window.requestAnimationFrame(flushPending);
        }
      });
      const offMeta = window.anchor.workspace.onSearchMeta?.((payload) => {
        if (payload.requestId !== requestId) return;
        if (gen !== searchGen.current) return;
        setSearchSource(payload.source);
      });

      try {
        // Pass workspace excludes as discrete list entries (not comma-joined)
        // so multi-segment paths like packages/legacy are not mangled.
        const excludeList = [
          ...(opts.exclude.trim() ? [opts.exclude.trim()] : []),
          ...opts.workspaceExcludes,
        ];
        const result = await window.anchor.workspace.searchContent({
          root: workspaceRoot,
          query: q,
          maxResults,
          include: opts.include,
          exclude: excludeList.length > 0 ? excludeList : undefined,
          useRegex: opts.useRegex,
          caseSensitive: opts.caseSensitive,
          requestId,
        });
        if (gen !== searchGen.current) return;
        if (raf) {
          window.cancelAnimationFrame(raf);
          raf = 0;
        }
        // Final authoritative set (covers any miss/race in streaming).
        const finalHits =
          opts.workspaceExcludes.length === 0
            ? result.hits
            : result.hits.filter(
                (h) => !pathMatchesExclude(h.path, opts.workspaceExcludes),
              );
        setHits(finalHits);
        setTruncated(result.truncated);
        setSearchSource(result.source);
      } catch (err) {
        if (gen !== searchGen.current) return;
        setHits([]);
        setTruncated(false);
        setSearchSource(null);
        setSearchError(err instanceof Error ? err.message : String(err));
      } finally {
        offHits?.();
        offMeta?.();
        if (raf) window.cancelAnimationFrame(raf);
        if (gen === searchGen.current) setSearching(false);
      }
    },
    [workspaceRoot],
  );

  useEffect(() => {
    if (!workspaceRoot) {
      setQuery("");
      setHits([]);
      setSearchError(null);
      return;
    }
    // Short debounce; in-flight work is cancelled via searchGen on retype.
    const t = window.setTimeout(() => {
      void runSearch(query, {
        include,
        exclude,
        useRegex,
        caseSensitive,
        workspaceExcludes,
      });
    }, 100);
    return () => window.clearTimeout(t);
  }, [
    query,
    include,
    exclude,
    useRegex,
    caseSensitive,
    workspaceExcludes,
    workspaceRoot,
    runSearch,
  ]);

  const openHit = (hit: SearchHit) => {
    if (!workspaceRoot) return;
    const abs = joinPath(workspaceRoot, hit.path);
    void openFileFromTree(abs, {
      revealLine: hit.line,
      searchHighlight: {
        line: hit.line,
        query,
        useRegex,
        caseSensitive,
      },
    });
  };

  const fileGroups = useMemo(() => groupHitsByFile(hits), [hits]);

  const allFilesExpanded =
    fileGroups.length > 0 &&
    fileGroups.every((g) => !collapsedFiles.has(g.path));

  const toggleAllFiles = useCallback(() => {
    if (allFilesExpanded) {
      setCollapsedFiles(new Set(fileGroups.map((g) => g.path)));
    } else {
      setCollapsedFiles(new Set());
    }
  }, [allFilesExpanded, fileGroups]);

  const toggleFileGroup = useCallback((path: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const onResizePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      resizeDrag.current = { startY: e.clientY, startH: resultsHeightRef.current };
      e.currentTarget.setPointerCapture(e.pointerId);
      document.body.classList.add("files-split-resizing");
    },
    [],
  );

  const onResizePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = resizeDrag.current;
      if (!drag) return;
      const paneH = paneRef.current?.clientHeight ?? 600;
      const maxH = Math.max(160, paneH - 180);
      const next = Math.min(
        maxH,
        Math.max(120, drag.startH + (e.clientY - drag.startY)),
      );
      setResultsHeight(next);
    },
    [],
  );

  const onResizePointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!resizeDrag.current) return;
      resizeDrag.current = null;
      document.body.classList.remove("files-split-resizing");
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      try {
        localStorage.setItem(
          "anchor.filesSearchResultsHeight",
          String(resultsHeightRef.current),
        );
      } catch {
        // ignore
      }
    },
    [],
  );

  if (!workspaceRoot) {
    return (
      <div className="files-pane">
        <div className="files-pane__title">NO WORKSPACE</div>
        <p className="pane-hint">
          Use <strong>Open Workspace</strong> below (or File menu) to choose a
          folder. Non-git directories are fine for reading.
        </p>
        <div className="files-pane__actions">
          <button
            type="button"
            className="btn btn--accent files-pane__open-ws"
            onClick={() =>
              void import("@/features/shell/orchestrate").then((m) =>
                m.openWorkspaceFromPicker(),
              )
            }
          >
            <Icon name="folder-opened" className="files-pane__open-ws-icon" />
            Open Workspace
          </button>
        </div>
        {status === "error" && error ? (
          <p className="pane-hint pane-hint--error">{error}</p>
        ) : null}
        {recent.length > 0 ? (
          <div className="recent-list">
            <div className="files-pane__title">RECENT</div>
            <ul className="file-tree recent-list__items">
              {recent.map((r) => {
                const name =
                  r.path.split(/[/\\]/).filter(Boolean).pop() ?? r.path;
                const hostLabel =
                  r.hostProfileId === "local-default"
                    ? "local"
                    : r.hostProfileId === "wsl-default"
                      ? "wsl"
                      : r.hostProfileId;
                return (
                  <li key={`${r.hostProfileId}:${r.path}`}>
                    <button
                      type="button"
                      className="file-tree__row recent-row"
                      title={`${r.path} (${hostLabel})`}
                      onClick={() =>
                        void openWorkspacePath(r.path, r.hostProfileId)
                      }
                    >
                      <Icon name="folder" className="file-tree__icon" />
                      <span className="recent-row__text">
                        <span className="recent-row__name">{name}</span>
                        <span className="recent-row__path">{r.path}</span>
                      </span>
                      <span className="recent-row__host">{hostLabel}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>
    );
  }

  if (status === "loading") {
    return (
      <div className="files-pane">
        <div className="files-pane__title">LOADING…</div>
        <p className="pane-hint" title={workspaceRoot}>
          {workspaceName ?? workspaceRoot}
        </p>
      </div>
    );
  }

  const qTrim = query.trim();
  const hasSearchQuery =
    qTrim.length >= 1 && (useRegex || qTrim.length >= 2);

  const resultsMeta = searching
    ? "Searching…"
    : searchError
      ? "Search failed"
      : hits.length === 0
        ? "No matches"
        : `${hits.length} result${hits.length === 1 ? "" : "s"}${
            truncated ? "+" : ""
          }${searchSource ? ` · ${searchSource}` : ""}`;

  const submitExcludeDraft = () => {
    const p = excludeDraft.trim();
    if (!p) return;
    void addExcludePattern(p);
    setExcludeDraft("");
  };

  const explorer = (
    <section className="files-section files-section--tree">
      <div className="files-section__head-row files-section__head-row--static">
        <div className="files-section__head files-section__head--static">
          <span className="files-section__label">EXPLORER</span>
        </div>
        <div className="files-section__head-actions">
          <button
            type="button"
            className={`icon-btn files-section__bulk${
              workspaceFilterOpen || workspaceExcludes.length > 0
                ? " is-active"
                : ""
            }`}
            title="Excluded paths for this workspace"
            aria-label="Excluded paths"
            aria-pressed={workspaceFilterOpen}
            onClick={() => setWorkspaceFilterOpen((v) => !v)}
          >
            <Icon name="filter" />
            {workspaceExcludes.length > 0 ? (
              <span className="files-exclude-badge">
                {workspaceExcludes.length}
              </span>
            ) : null}
          </button>
        </div>
      </div>
      {workspaceFilterOpen ? (
        <div className="files-exclude-panel">
          <p className="files-exclude-panel__hint">
            Hide folders/files from the tree and search. Right-click a row →
            Exclude. Patterns are relative (e.g. <code>vendor</code>,{" "}
            <code>**/*.log</code>).
          </p>
          <div className="files-exclude-panel__add">
            <input
              type="text"
              className="files-exclude-panel__input"
              value={excludeDraft}
              onChange={(e) => setExcludeDraft(e.target.value)}
              placeholder="path or glob…"
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitExcludeDraft();
                }
              }}
            />
            <button
              type="button"
              className="btn btn--small"
              disabled={!excludeDraft.trim()}
              onClick={submitExcludeDraft}
            >
              Add
            </button>
          </div>
          {workspaceExcludes.length === 0 ? (
            <p className="pane-hint">Nothing excluded.</p>
          ) : (
            <ul className="files-exclude-list">
              {workspaceExcludes.map((p) => (
                <li key={p} className="files-exclude-list__row">
                  <span className="files-exclude-list__path" title={p}>
                    {p}
                  </span>
                  <button
                    type="button"
                    className="icon-btn"
                    title="Show again"
                    aria-label={`Remove exclude ${p}`}
                    onClick={() => void removeExclude(p)}
                  >
                    <Icon name="close" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      <div className="files-tree-scroll">
        {rootEntries.length > 0 ? (
          <ul className="file-tree" role="tree">
            {rootEntries.map((node) => (
              <TreeRow
                key={node.path}
                node={node}
                depth={0}
                selectedPath={selectedPath}
                onToggle={(p) => void toggleDir(p)}
                onOpenFile={(p) => void openFileFromTree(p)}
                onContextMenu={openTreeMenu}
              />
            ))}
          </ul>
        ) : status === "error" ? (
          <button
            type="button"
            className="btn btn--ghost btn--small"
            style={{ margin: 12 }}
            onClick={() => void openWorkspacePath(workspaceRoot)}
          >
            Retry
          </button>
        ) : (
          <p className="pane-hint">Empty folder.</p>
        )}
      </div>
      {treeMenu ? (
        <div
          ref={treeMenuRef}
          className="file-tree-menu"
          style={{ left: treeMenu.x, top: treeMenu.y }}
          role="menu"
          aria-label={`${treeMenu.name} actions`}
        >
          <button
            type="button"
            className="file-tree-menu__item"
            role="menuitem"
            onClick={() => {
              void addExclude(treeMenu.path);
              setTreeMenu(null);
            }}
          >
            Exclude from workspace view
          </button>
        </div>
      ) : null}
    </section>
  );

  return (
    <div className="files-pane" ref={paneRef}>
      <div className="files-pane__title" title={workspaceRoot}>
        {(workspaceName ?? "WORKSPACE").toUpperCase()}
        {status === "error" ? " (ERROR)" : " (WORKSPACE)"}
      </div>

      <div className="files-search">
        <Icon name="search" className="files-search__icon" />
        <input
          type="search"
          className="files-search__input"
          placeholder={useRegex ? "Regex search…" : "Search in files…"}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (e.target.value.trim()) setResultsOpen(true);
          }}
          aria-label="Search in files"
          spellCheck={false}
          autoComplete="off"
        />
        <button
          type="button"
          className={`icon-btn files-search__toggle${useRegex ? " is-active" : ""}`}
          title="Use regular expression"
          aria-label="Use regular expression"
          aria-pressed={useRegex}
          onClick={() => setUseRegex((v) => !v)}
        >
          <Icon name="regex" />
        </button>
        <button
          type="button"
          className={`icon-btn files-search__toggle${caseSensitive ? " is-active" : ""}`}
          title="Match case"
          aria-label="Match case"
          aria-pressed={caseSensitive}
          onClick={() => setCaseSensitive((v) => !v)}
        >
          <Icon name="case-sensitive" />
        </button>
        <button
          type="button"
          className={`icon-btn files-search__toggle${filtersOpen || include || exclude ? " is-active" : ""}`}
          title="Include / exclude files"
          aria-label="Include and exclude filters"
          aria-pressed={filtersOpen}
          onClick={() => setFiltersOpen((v) => !v)}
        >
          <Icon name="filter" />
        </button>
      </div>

      {filtersOpen ? (
        <div className="files-search-filters">
          <label className="files-search-filters__row">
            <span className="files-search-filters__label">
              files to include
            </span>
            <input
              type="text"
              className="files-search-filters__input"
              placeholder="e.g. *.ts, src/**"
              value={include}
              onChange={(e) => setInclude(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <label className="files-search-filters__row">
            <span className="files-search-filters__label">
              files to exclude
            </span>
            <input
              type="text"
              className="files-search-filters__input"
              placeholder="e.g. dist, *.min.js"
              value={exclude}
              onChange={(e) => setExclude(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
        </div>
      ) : null}

      {status === "error" && error ? (
        <p className="pane-hint pane-hint--error">{error}</p>
      ) : null}

  {hasSearchQuery ? (
        <div className="files-pane__split">
          <div
            className={`files-search-results${resultsOpen ? " is-open" : ""}`}
            style={
              resultsOpen
                ? { height: resultsHeight, flex: "0 0 auto" }
                : undefined
            }
          >
            <div className="files-section__head-row">
              <button
                type="button"
                className="files-section__head"
                onClick={() => setResultsOpen((v) => !v)}
                aria-expanded={resultsOpen}
              >
                <Icon
                  name={resultsOpen ? "chevron-down" : "chevron-right"}
                  className="files-section__chevron"
                />
                <span className="files-section__label">RESULTS</span>
                <span className="files-section__meta">{resultsMeta}</span>
              </button>
              {resultsOpen && fileGroups.length > 0 ? (
                <div className="files-section__head-actions">
                  <button
                    type="button"
                    className="icon-btn files-section__bulk"
                    title={
                      allFilesExpanded
                        ? "Collapse all files (filename only)"
                        : "Expand all files (show match lines)"
                    }
                    aria-label={
                      allFilesExpanded
                        ? "Collapse all files"
                        : "Expand all files"
                    }
                    onClick={toggleAllFiles}
                  >
                    <Icon
                      name={allFilesExpanded ? "chevron-right" : "chevron-down"}
                    />
                  </button>
                </div>
              ) : null}
            </div>
            {resultsOpen ? (
              <div className="files-search-results__body">
                {searchError ? (
                  <p className="pane-hint pane-hint--error">{searchError}</p>
                ) : null}
                <ul className="files-search-results__list">
                  {fileGroups.map((group) => {
                    const dir = fileDirname(group.path);
                    const collapsed = collapsedFiles.has(group.path);
                    return (
                      <li
                        key={group.path}
                        className={`files-search-group${collapsed ? " is-collapsed" : ""}`}
                      >
                        <button
                          type="button"
                          className="files-search-group__head"
                          title={
                            collapsed
                              ? `Expand ${group.path}`
                              : `Collapse ${group.path}`
                          }
                          aria-expanded={!collapsed}
                          onClick={() => toggleFileGroup(group.path)}
                        >
                          <Icon
                            name={collapsed ? "chevron-right" : "chevron-down"}
                            className="files-search-group__chevron"
                          />
                          <span className="files-search-group__file">
                            {fileBasename(group.path)}
                          </span>
                          {dir ? (
                            <span className="files-search-group__dir">
                              {dir}
                            </span>
                          ) : null}
                          <span className="files-search-group__count">
                            {group.hits.length}
                          </span>
                        </button>
                        {!collapsed ? (
                          <ul className="files-search-group__hits">
                            {group.hits.map((hit, i) => (
                              <li key={`${hit.line}:${i}`}>
                                <button
                                  type="button"
                                  className="files-search-hit"
                                  title={`${hit.path}:${hit.line}`}
                                  onClick={() => openHit(hit)}
                                >
                                  <span className="files-search-hit__line">
                                    {hit.line}
                                  </span>
                                  <span className="files-search-hit__text">
                                    {highlightPreview(
                                      hit.text,
                                      query,
                                      useRegex,
                                      caseSensitive,
                                    )}
                                  </span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </div>

          {resultsOpen ? (
            <div
              className="files-split-sash"
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize search results"
              title="Drag to resize"
              onPointerDown={onResizePointerDown}
              onPointerMove={onResizePointerMove}
              onPointerUp={onResizePointerUp}
              onPointerCancel={onResizePointerUp}
            />
          ) : null}

          {explorer}
        </div>
      ) : (
        explorer
      )}
    </div>
  );
}

function TreeRow({
  node,
  depth,
  selectedPath,
  onToggle,
  onOpenFile,
  onContextMenu,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
  onContextMenu: (
    e: ReactMouseEvent,
    node: { path: string; name: string; type: "file" | "dir" },
  ) => void;
}) {
  const selected = selectedPath === node.path;
  const pad = 8 + depth * 12;

  if (node.type === "dir") {
    return (
      <li role="treeitem" aria-expanded={node.expanded}>
        <button
          type="button"
          className={`file-tree__row${selected ? " is-selected" : ""}`}
          style={{ paddingLeft: pad }}
          onClick={() => onToggle(node.path)}
          onContextMenu={(e) =>
            onContextMenu(e, {
              path: node.path,
              name: node.name,
              type: "dir",
            })
          }
        >
          <Icon
            name={node.expanded ? "chevron-down" : "chevron-right"}
            className="file-tree__chevron"
          />
          <Icon
            name={node.expanded ? "folder-opened" : "folder"}
            className="file-tree__icon"
          />
          <span className="file-tree__name">{node.name}</span>
        </button>
        {node.error ? (
          <div className="file-tree__error" style={{ paddingLeft: pad + 20 }}>
            {node.error}
          </div>
        ) : null}
        {node.expanded && node.children ? (
          <ul className="file-tree file-tree--nested" role="group">
            {node.children.map((child) => (
              <TreeRow
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedPath={selectedPath}
                onToggle={onToggle}
                onOpenFile={onOpenFile}
                onContextMenu={onContextMenu}
              />
            ))}
          </ul>
        ) : null}
      </li>
    );
  }

  return (
    <li role="treeitem">
      <button
        type="button"
        className={`file-tree__row${selected ? " is-selected" : ""}`}
        style={{ paddingLeft: pad + 14 }}
        onClick={() => onOpenFile(node.path)}
        onContextMenu={(e) =>
          onContextMenu(e, {
            path: node.path,
            name: node.name,
            type: "file",
          })
        }
      >
        <Icon name={fileIcon(node.name)} className="file-tree__icon" />
        <span className="file-tree__name">{node.name}</span>
      </button>
    </li>
  );
}

function fileBasename(filePath: string): string {
  const norm = filePath.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i >= 0 ? norm.slice(i + 1) : norm;
}

function fileDirname(filePath: string): string {
  const norm = filePath.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i > 0 ? norm.slice(0, i) : "";
}

function fileIcon(name: string): CodiconName {
  const lower = name.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return "markdown";
  if (lower.endsWith(".json") || lower.endsWith(".jsonc")) return "json";
  if (
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".js") ||
    lower.endsWith(".jsx") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs") ||
    lower.endsWith(".css") ||
    lower.endsWith(".scss") ||
    lower.endsWith(".html") ||
    lower.endsWith(".py") ||
    lower.endsWith(".rs") ||
    lower.endsWith(".go")
  ) {
    return "file-code";
  }
  return "file";
}
