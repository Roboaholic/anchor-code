import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { joinPath } from "@/core/workspace/paths";
import type { FuzzyMatch } from "@/core/workspace/fuzzy";
import { FuzzySearchClient } from "./fuzzySearchClient";
import { FileIndexCache, type FileIndexRequest, type CachedFileIndex } from "./fileIndexCache";
import { Icon } from "@/shared/Icon";
import { formatError } from "@/shared/formatError";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import {
  loadSearchSettings,
} from "@/features/files/searchResults";
import { openFileFromTree } from "./orchestrate";
import { useShellStore, type PaletteMode } from "./shellStore";

/** Keep in sync with electron/services/fileIndex.ts DEFAULT_MAX_FILES. */
const FILE_INDEX_MAX_FILES = 200_000;
const EMPTY_FILES: string[] = [];
const fileIndexCache = new FileIndexCache();
const deltaWarmTimers = new Map<string, ReturnType<typeof setTimeout>>();

function indexRequest(root: string): FileIndexRequest {
  const { hostKind, hostProfileId } = useWorkspaceStore.getState();
  const settings = loadSearchSettings(root);
  return { root, hostKind, hostProfileId, respectIgnore: settings.respectIgnore,
    defaultExcludes: settings.defaultExcludes ?? undefined };
}

function findFilesArgs(request: FileIndexRequest, extra?: { query?: string }) {
  return { root: request.root, maxFiles: FILE_INDEX_MAX_FILES, query: extra?.query,
    respectIgnore: request.respectIgnore, defaultExcludes: request.defaultExcludes };
}

function loadFileIndex(request: FileIndexRequest): Promise<CachedFileIndex> {
  return fileIndexCache.load(request, () => {
    const current = useWorkspaceStore.getState();
    if (current.hostKind !== request.hostKind || current.hostProfileId !== request.hostProfileId) {
      throw new Error("Workspace host changed while preparing the file index");
    }
    return window.anchor.workspace.findFiles(findFilesArgs(request));
  });
}

export function invalidateFileIndexCache(root?: string): void {
  fileIndexCache.invalidate(root);
  for (const [key, timer] of deltaWarmTimers) {
    if (!root || key === root) { clearTimeout(timer); deltaWarmTimers.delete(key); }
  }
}

/** Removes paths immediately; additions revalidate against authoritative ignore rules. */
export function applyFileIndexDelta(root: string, changes: { rel: string; exists: boolean }[]): void {
  const request = indexRequest(root);
  const cached = fileIndexCache.peek(request);
  if (!changes.length) return;
  const indexed = new Set(cached?.files ?? []);
  const deleted: string[] = [];
  let added = false;
  for (const change of changes) {
    const rel = change.rel.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
    if (!rel) continue;
    if (!change.exists) deleted.push(rel);
    else if (!indexed.has(rel)) added = true;
  }
  fileIndexCache.remove(request, deleted);
  if (added) {
    // The renderer does not have the complete .anchorignore/Git ignore rules.
    fileIndexCache.invalidate(root);
    const timer = deltaWarmTimers.get(root);
    if (timer) clearTimeout(timer);
    deltaWarmTimers.set(root, setTimeout(() => {
      deltaWarmTimers.delete(root);
      const current = indexRequest(root);
      if (current.hostKind === request.hostKind && current.hostProfileId === request.hostProfileId &&
          useWorkspaceStore.getState().workspaceRoot === root) warmFileIndexCache(root);
    }, 100));
  }
}

/** Background warm and first Ctrl+P share the same host/filter-scoped request. */
export function warmFileIndexCache(root: string | null | undefined): void {
  if (root) void loadFileIndex(indexRequest(root)).catch(() => {
    // Quick Open can still surface errors when the user requests the index.
  });
}

function highlightText(text: string, indices: number[]): ReactNode {
  if (indices.length === 0) return text;
  const set = new Set(indices);
  const parts: ReactNode[] = [];
  let buf = "";
  let bufMatch = false;
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i);
    if (i === 0) {
      bufMatch = m;
      buf = text[i]!;
      continue;
    }
    if (m === bufMatch) {
      buf += text[i]!;
    } else {
      parts.push(
        bufMatch ? (
          <mark key={parts.length} className="quick-open__mark">
            {buf}
          </mark>
        ) : (
          <span key={parts.length}>{buf}</span>
        ),
      );
      buf = text[i]!;
      bufMatch = m;
    }
  }
  if (buf) {
    parts.push(
      bufMatch ? (
        <mark key={parts.length} className="quick-open__mark">
          {buf}
        </mark>
      ) : (
        <span key={parts.length}>{buf}</span>
      ),
    );
  }
  return parts;
}

export function QuickOpenPalette() {
  const mode = useShellStore((s) => s.palette);
  const closePalette = useShellStore((s) => s.closePalette);

  if (!mode) return null;

  return (
    <div
      className="modal-backdrop quick-open-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closePalette();
      }}
    >
      {mode === "quickOpen" ? (
        <QuickOpenDialog onClose={closePalette} />
      ) : (
        <OpenPathDialog onClose={closePalette} />
      )}
    </div>
  );
}

function QuickOpenDialog({ onClose }: { onClose: () => void }) {
  const workspaceRoot = useWorkspaceStore((s) => s.workspaceRoot);
  const hostProfileId = useWorkspaceStore((s) => s.hostProfileId);
  const hostKind = useWorkspaceStore((s) => s.hostKind);
  const scope = JSON.stringify([workspaceRoot, hostProfileId, hostKind]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [fileState, setFileState] = useState<{ scope: string; files: string[] } | null>(null);
  const files = fileState?.scope === scope ? fileState.files : EMPTY_FILES;
  const [truncated, setTruncated] = useState(false);
  const [source, setSource] = useState<"git" | "walk" | "multi-git" | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [indexMs, setIndexMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queryResult, setQueryResult] = useState<{ scope: string; query: string; files: string[] } | null>(null);
  const queryFiles = queryResult?.scope === scope && queryResult.query === query.trim() ? queryResult.files : null;
  const [queryLoading, setQueryLoading] = useState(false);
  const [active, setActive] = useState(0);
  const [ranked, setRanked] = useState<{ files: string[]; query: string; matches: FuzzyMatch[] } | null>(null);
  const [ranking, setRanking] = useState(false);
  const rankerRef = useRef<FuzzySearchClient | null>(null);
  const rankFiles = queryFiles ?? files;
  const matches = ranked?.files === rankFiles && ranked.query === query ? ranked.matches : [];
  const searchBusy = Boolean(workspaceRoot && !error && (
    indexing || loading || queryLoading || ranking ||
    ranked?.files !== rankFiles || ranked.query !== query
  ));

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const setFiles = (files: string[]) => setFileState({ scope, files });
    if (!workspaceRoot) {
      setFiles([]);
      setError("Open a workspace first");
      return;
    }
    let cancelled = false;
    const request = indexRequest(workspaceRoot);
    const cached = fileIndexCache.peek(request);
    const applyIndex = (idx: CachedFileIndex) => {
      setFiles(idx.files);
      setTruncated(idx.truncated);
      setSource(idx.source ?? null);
    };
    // Remote caches are immediately usable while the backend revalidates them.
    if (cached) applyIndex(cached);
    else { setFiles([]); setTruncated(false); setSource(null); }
    setLoading(!cached);
    setIndexing(true);
    setError(null);
    setIndexMs(null);
    const t0 = performance.now();
    void loadFileIndex(request)
      .then((idx) => {
        if (cancelled) return;
        applyIndex(idx);
        setIndexMs(Math.round(performance.now() - t0));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(formatError(err));
        if (!cached) setFiles([]);
      })
      .finally(() => { if (!cancelled) { setLoading(false); setIndexing(false); } });
    return () => { cancelled = true; };
  }, [workspaceRoot, hostProfileId, hostKind, scope]);

  useEffect(() => {
    const normalizedQuery = query.trim();
    if (!workspaceRoot || !truncated || !normalizedQuery) {
      setQueryResult(null);
      setQueryLoading(false);
      return;
    }

    setQueryResult(null);
    setQueryLoading(true);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void window.anchor.workspace
        .findFiles(findFilesArgs(indexRequest(workspaceRoot), { query: normalizedQuery }))
        .then((result) => {
          if (!cancelled) setQueryResult({ scope, query: normalizedQuery, files: result.files });
        })
        .catch((err) => {
          if (!cancelled) setError(formatError(err));
        })
        .finally(() => {
          if (!cancelled) setQueryLoading(false);
        });
    }, 150);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, truncated, workspaceRoot, hostProfileId, hostKind, scope]);

  useEffect(() => {
    const ranker = new FuzzySearchClient();
    rankerRef.current = ranker;
    return () => { ranker.dispose(); rankerRef.current = null; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setRanking(true);
    void rankerRef.current?.search(rankFiles, query, 80).then((next) => {
      if (cancelled) return;
      setRanked({ files: rankFiles, query, matches: next });
      setRanking(false);
    });
    return () => { cancelled = true; };
  }, [rankFiles, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${active}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [active, matches.length]);

  const openMatch = useCallback(
    async (rel: string) => {
      if (!workspaceRoot) return;
      const abs = joinPath(workspaceRoot, rel);
      onClose();
      await openFileFromTree(abs);
    },
    [workspaceRoot, onClose],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(matches.length - 1, 0)));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const hit = matches[active];
      if (hit) void openMatch(hit.path);
    }
  };

  return (
    <div
      className="quick-open"
      role="dialog"
      aria-modal="true"
      aria-label="Go to File"
    >
      <div className="quick-open__input-row">
        <Icon name="search" className="quick-open__icon" />
        <input
          ref={inputRef}
          className="quick-open__input"
          placeholder={
            workspaceRoot
              ? "Search files by name…"
              : "Open a workspace to search files"
          }
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
          disabled={!workspaceRoot}
        />
        <kbd className="quick-open__kbd">Esc</kbd>
      </div>

      {error ? <p className="quick-open__status quick-open__status--error">{error}</p> : null}
      {!error && workspaceRoot ? (
        <p className="quick-open__status" role="status">
          {searchBusy ? <Icon name="loading" className="quick-open__spinner codicon-modifier-spin" /> : null}
          {loading ? "Indexing workspace…" : query.trim()
            ? `${matches.length} match${matches.length === 1 ? "" : "es"}`
            : `Showing ${matches.length.toLocaleString()} of ${files.length.toLocaleString()} files`}
          {source ? ` · via ${source}` : ""}
          {indexMs != null ? ` · ${indexMs}ms` : ""}
          {truncated && !query.trim() ? " · index truncated" : ""}
          {!loading && searchBusy ? " · Searching…" : ""}
          {loadSearchSettings(workspaceRoot).respectIgnore
            ? " · excludes via .anchorignore / workspace defaults"
            : ""}
        </p>
      ) : null}

      <ul className="quick-open__list" role="listbox" aria-label="Matching files" aria-busy={searchBusy} ref={listRef}>
        {matches.map((m, i) => {
          const dir =
            m.path.includes("/") || m.path.includes("\\")
              ? m.path.replace(/\\/g, "/").replace(/\/[^/]+$/, "")
              : "";
          return (
            <li key={m.path} role="presentation">
              <button
                type="button"
                role="option"
                data-index={i}
                aria-selected={i === active}
                className={`quick-open__item${i === active ? " is-active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => void openMatch(m.path)}
              >
                <Icon name="file" className="quick-open__item-icon" />
                <span className="quick-open__item-main">
                  <span className="quick-open__item-name">
                    {highlightText(m.name, m.indices)}
                  </span>
                  {dir ? (
                    <span className="quick-open__item-path">
                      {highlightText(dir, m.pathIndices ?? [])}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
        {!searchBusy && !error && matches.length === 0 && workspaceRoot ? (
          <li className="quick-open__empty">No matching files</li>
        ) : null}
      </ul>
    </div>
  );
}

function OpenPathDialog({ onClose }: { onClose: () => void }) {
  const workspaceRoot = useWorkspaceStore((s) => s.workspaceRoot);
  const hostKind = useWorkspaceStore((s) => s.hostKind);
  const inputRef = useRef<HTMLInputElement>(null);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const resolvePath = useCallback(
    (raw: string): string => {
      const t = raw.trim().replace(/^["']|["']$/g, "");
      if (!t) return t;
      // Absolute (POSIX or Windows drive)
      if (t.startsWith("/") || /^[A-Za-z]:[\\/]/.test(t) || t.startsWith("\\\\")) {
        return t;
      }
      if (workspaceRoot) return joinPath(workspaceRoot, t);
      return t;
    },
    [workspaceRoot],
  );

  const openResolved = useCallback(
    async (resolved: string) => {
      setBusy(true);
      setError(null);
      try {
        const st = await window.anchor.workspace.stat(resolved);
        if (!st.isFile) {
          setError("Not a file");
          return;
        }
        onClose();
        await openFileFromTree(resolved);
      } catch (err) {
        setError(formatError(err));
      } finally {
        setBusy(false);
      }
    },
    [onClose],
  );

  const onSubmit = () => {
    const resolved = resolvePath(path);
    if (!resolved) {
      setError("Enter a file path");
      return;
    }
    void openResolved(resolved);
  };

  const onBrowse = async () => {
    if (hostKind !== "local") {
      setError("Browse is only available on Local host — type a path instead");
      return;
    }
    try {
      const picked = await window.anchor.workspace.pickFile();
      if (picked) {
        setPath(picked);
        await openResolved(picked);
      }
    } catch (err) {
      setError(formatError(err));
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div
      className="quick-open quick-open--path"
      role="dialog"
      aria-modal="true"
      aria-label="Open File by Path"
    >
      <div className="quick-open__input-row">
        <Icon name="folder-opened" className="quick-open__icon" />
        <input
          ref={inputRef}
          className="quick-open__input"
          placeholder={
            workspaceRoot
              ? "Absolute path or path relative to workspace…"
              : "Absolute path to a file…"
          }
          value={path}
          onChange={(e) => {
            setPath(e.target.value);
            setError(null);
          }}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
        />
        <kbd className="quick-open__kbd">Enter</kbd>
      </div>
      {error ? <p className="quick-open__status quick-open__status--error">{error}</p> : null}
      <div className="quick-open__path-actions">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={onClose}
          disabled={busy}
        >
          Cancel
        </button>
        {hostKind === "local" ? (
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void onBrowse()}
            disabled={busy}
          >
            Browse…
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn--accent"
          onClick={onSubmit}
          disabled={busy || !path.trim()}
        >
          Open
        </button>
      </div>
    </div>
  );
}

/** Keep type export for callers that branch on mode. */
export type { PaletteMode };
