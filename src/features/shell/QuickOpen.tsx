import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { joinPath } from "@/core/workspace/paths";
import { rankFuzzyPaths, type FuzzyMatch } from "@/core/workspace/fuzzy";
import { Icon } from "@/shared/Icon";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import { openFileFromTree } from "./orchestrate";
import { useShellStore, type PaletteMode } from "./shellStore";
const FILE_INDEX_CACHE_TTL_MS = 5 * 60_000;

type IndexCache = {
  root: string;
  files: string[];
  truncated: boolean;
  source?: "git" | "walk" | "multi-git";
  at: number;
};

let fileIndexCache: IndexCache | null = null;
/** In-flight warm so open-workspace + first Ctrl+P share one findFiles. */
let fileIndexInflight: Promise<IndexCache> | null = null;

async function loadFileIndex(root: string, force = false): Promise<IndexCache> {
  if (
    !force &&
    fileIndexCache &&
    fileIndexCache.root === root &&
    fileIndexCache.files.length > 0 &&
    Date.now() - fileIndexCache.at < FILE_INDEX_CACHE_TTL_MS
  ) {
    return fileIndexCache;
  }

  // Share one in-flight findFiles between workspace warm and first Ctrl+P.
  if (!force && fileIndexInflight) {
    try {
      const pending = await fileIndexInflight;
      if (pending.root === root) return pending;
    } catch {
      // fall through to a fresh load
    }
  }

  const run = (async (): Promise<IndexCache> => {
    const result = await window.anchor.workspace.findFiles({ root });
    const next: IndexCache = {
      root: result.root,
      files: result.files,
      truncated: result.truncated,
      source: result.source,
      at: Date.now(),
    };
    fileIndexCache = next;
    return next;
  })();

  fileIndexInflight = run;
  try {
    return await run;
  } finally {
    if (fileIndexInflight === run) fileIndexInflight = null;
  }
}

export function invalidateFileIndexCache(): void {
  fileIndexCache = null;
  fileIndexInflight = null;
}

/** Background warm so the first Ctrl+P is not a cold multi-repo scan. */
export function warmFileIndexCache(root: string | null | undefined): void {
  if (!root) return;
  if (
    fileIndexCache &&
    fileIndexCache.root === root &&
    fileIndexCache.files.length > 0 &&
    Date.now() - fileIndexCache.at < FILE_INDEX_CACHE_TTL_MS
  ) {
    return;
  }
  if (fileIndexInflight) return;
  void loadFileIndex(root).catch(() => {
    // quiet warm — Quick Open will surface errors on demand
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
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [source, setSource] = useState<"git" | "walk" | "multi-git" | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [indexMs, setIndexMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queryFiles, setQueryFiles] = useState<string[] | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);
  const [active, setActive] = useState(0);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    if (!workspaceRoot) {
      setFiles([]);
      setError("Open a workspace first");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setIndexMs(null);
    const t0 = performance.now();
    // Always re-fetch when dialog opens if last cache was empty (bad prior index).
    const force = !fileIndexCache || fileIndexCache.files.length === 0;
    void loadFileIndex(workspaceRoot, force)
      .then((idx) => {
        if (cancelled) return;
        setFiles(idx.files);
        setTruncated(idx.truncated);
        setSource(idx.source ?? null);
        setIndexMs(Math.round(performance.now() - t0));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setFiles([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceRoot]);

  useEffect(() => {
    const normalizedQuery = query.trim();
    if (!workspaceRoot || !truncated || !normalizedQuery) {
      setQueryFiles(null);
      setQueryLoading(false);
      return;
    }

    setQueryFiles(null);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setQueryLoading(true);
      void window.anchor.workspace
        .findFiles({ root: workspaceRoot, query: normalizedQuery })
        .then((result) => {
          if (!cancelled) setQueryFiles(result.files);
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!cancelled) setQueryLoading(false);
        });
    }, 150);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, truncated, workspaceRoot]);

  const matches: FuzzyMatch[] = useMemo(
    () => rankFuzzyPaths(queryFiles ?? files, query, 80),
    [files, query, queryFiles],
  );

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
      {loading ? (
        <p className="quick-open__status">Indexing multi-repo workspace…</p>
      ) : null}
      {!loading && !error && workspaceRoot ? (
        <p className="quick-open__status">
          {matches.length} match{matches.length === 1 ? "" : "es"}
          {query.trim() ? "" : ` · ${files.length.toLocaleString()} files`}
          {source ? ` · via ${source}` : ""}
          {indexMs != null ? ` · ${indexMs}ms` : ""}
          {truncated && !query.trim() ? " · index truncated" : ""}
          {queryLoading ? " · searching full index" : ""}
        </p>
      ) : null}

      <ul className="quick-open__list" role="listbox" ref={listRef}>
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
                    <span className="quick-open__item-path">{dir}</span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
        {!loading && !error && matches.length === 0 && workspaceRoot ? (
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
        setError(err instanceof Error ? err.message : String(err));
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
      setError(err instanceof Error ? err.message : String(err));
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
