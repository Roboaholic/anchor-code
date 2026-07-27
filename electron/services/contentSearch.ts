import type { HostSession } from "../host/types.js";
import { hostJoin } from "../host/paths.js";
import { findWorkspaceFiles } from "./fileIndex.js";

export interface ContentSearchHit {
  /** Path relative to workspace root, `/` separators. */
  path: string;
  line: number;
  text: string;
}

export interface ContentSearchOptions {
  maxResults?: number;
  caseSensitive?: boolean;
  /** Use regular expression instead of fixed-string match. */
  useRegex?: boolean;
  /** Glob patterns for files to include (array or comma/space-separated). Empty = all. */
  include?: string | string[];
  /** Glob patterns to exclude (e.g. node_modules, dist, minified assets). */
  exclude?: string | string[];
}

export interface ContentSearchResult {
  root: string;
  query: string;
  hits: ContentSearchHit[];
  truncated: boolean;
  source: "git-grep" | "rg" | "scan";
}

const DEFAULT_MAX_RESULTS = 200;
const SCAN_MAX_FILES = 2_000;
const SCAN_MAX_FILE_BYTES = 256 * 1024;
const SCAN_CONCURRENCY = 24;

/** Built-in excludes applied in post-filter / rg globs (not as git pathspecs). */
const DEFAULT_EXCLUDES = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  "target",
];

/** Cache which native engines work in a given workspace root. */
const engineCache = new Map<
  string,
  { rg: boolean | null; git: boolean | null }
>();

function engineState(root: string) {
  let s = engineCache.get(root);
  if (!s) {
    s = { rg: null, git: null };
    engineCache.set(root, s);
  }
  return s;
}

/**
 * Split a user-facing include/exclude field into patterns.
 * Supports comma, semicolon, and whitespace separators.
 */
export function splitPatterns(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((p) => p.trim()).filter(Boolean);
  }
  return raw
    .split(/[,;\n]+|\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Convert a simple glob to a RegExp matching full relative paths. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/\\/g, "/");
  if (!g) return /^$/;
  if (!g.includes("/") && !g.includes("*") && !g.includes("?")) {
    g = `**/${g}/**`;
  }
  if (g.startsWith("*.") || (g.startsWith("*") && !g.startsWith("**"))) {
    g = `**/${g}`;
  }
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*" && g[i + 1] === "*") {
      if (g[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const end = g.indexOf("}", i);
      if (end > i) {
        const alts = g
          .slice(i + 1, end)
          .split(",")
          .map((a) => a.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("|");
        re += `(?:${alts})`;
        i = end;
      } else {
        re += "\\{";
      }
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`, "i");
}

export function pathMatchesGlobs(
  relPath: string,
  include: string[],
  exclude: string[],
): boolean {
  const path = relPath.replace(/\\/g, "/");
  for (const ex of exclude) {
    if (globToRegExp(ex).test(path)) return false;
    const base = ex.replace(/\\/g, "/").replace(/\*\*/g, "").replace(/\//g, "");
    if (base && !ex.includes("*") && path.split("/").includes(base)) {
      return false;
    }
  }
  if (include.length === 0) return true;
  return include.some((inc) => globToRegExp(inc).test(path));
}

/**
 * Parse `path:line:text` lines from git-grep / ripgrep.
 */
export function parseGrepLine(line: string): ContentSearchHit | null {
  const raw = line.replace(/\r$/, "");
  if (!raw) return null;
  const m = raw.match(/^(.*?):(\d+):(.*)$/);
  if (!m) return null;
  const path = (m[1] ?? "").replace(/\\/g, "/");
  const lineNo = Number.parseInt(m[2] ?? "", 10);
  if (!path || !Number.isFinite(lineNo) || lineNo < 1) return null;
  return { path, line: lineNo, text: m[3] ?? "" };
}

export function parseGrepOutput(
  stdout: string,
  maxResults: number,
  include: string[],
  exclude: string[],
): { hits: ContentSearchHit[]; truncated: boolean } {
  const hits: ContentSearchHit[] = [];
  let truncated = false;
  for (const line of stdout.split("\n")) {
    const hit = parseGrepLine(line);
    if (!hit) continue;
    if (!pathMatchesGlobs(hit.path, include, exclude)) continue;
    hits.push(hit);
    if (hits.length >= maxResults) {
      truncated = true;
      break;
    }
  }
  return { hits, truncated };
}

function normalizeOpts(opts?: ContentSearchOptions): {
  maxResults: number;
  caseSensitive: boolean;
  useRegex: boolean;
  include: string[];
  exclude: string[];
  userExclude: string[];
} {
  const include = splitPatterns(opts?.include);
  const userExclude = splitPatterns(opts?.exclude);
  const exclude = [...DEFAULT_EXCLUDES, ...userExclude];
  return {
    maxResults: opts?.maxResults ?? DEFAULT_MAX_RESULTS,
    caseSensitive: opts?.caseSensitive === true,
    useRegex: opts?.useRegex === true,
    include,
    exclude,
    userExclude,
  };
}

/**
 * Search file contents under workspace root (Local / WSL / SSH).
 * Prefer ripgrep, then git grep (tracked files), then bounded parallel scan.
 */
export async function searchWorkspaceContent(
  host: HostSession,
  root: string,
  query: string,
  opts?: ContentSearchOptions,
): Promise<ContentSearchResult> {
  const q = query.trim();
  const o = normalizeOpts(opts);
  if (!q) {
    return { root, query: q, hits: [], truncated: false, source: "rg" };
  }
  if (o.useRegex) {
    try {
      // eslint-disable-next-line no-new
      new RegExp(q, o.caseSensitive ? "" : "i");
    } catch (err) {
      throw new Error(
        err instanceof Error ? `Invalid regex: ${err.message}` : "Invalid regex",
      );
    }
  }

  const engines = engineState(root);

  // ripgrep first — typically 5–20× faster than git grep on large trees.
  if (engines.rg !== false) {
    const viaRg = await tryRipgrep(host, root, q, o);
    if (viaRg) {
      engines.rg = true;
      return viaRg;
    }
    engines.rg = false;
  }

  if (engines.git !== false) {
    const viaGit = await tryGitGrep(host, root, q, o);
    if (viaGit) {
      engines.git = true;
      return viaGit;
    }
    engines.git = false;
  }

  return scanFiles(host, root, q, o);
}

async function tryGitGrep(
  host: HostSession,
  root: string,
  query: string,
  o: ReturnType<typeof normalizeOpts>,
): Promise<ContentSearchResult | null> {
  try {
    // Fast path: tracked index only (no --untracked — that walks the whole tree).
    // --exclude-standard still respects .gitignore for the few untracked we skip.
    const args = ["grep", "-n", "-I", "--full-name"];
    if (!o.useRegex) args.push("-F");
    if (o.useRegex) args.push("-E");
    if (!o.caseSensitive) args.push("-i");
    // Per-file cap keeps output small so we stop sooner.
    args.push("-m", "8", "-e", query, "--");

    if (o.include.length > 0) {
      for (const inc of o.include) {
        args.push(toGitPathspec(inc, false));
      }
    } else {
      args.push(".");
    }
    // Only user excludes as pathspecs — defaults are post-filtered (gitignore covers most).
    for (const ex of o.userExclude) {
      args.push(toGitPathspec(ex, true));
    }

    const r = await host.run(root, "git", args, { timeoutMs: 20_000 });
    if (r.code !== 0 && r.code !== 1) return null;
    const { hits, truncated } = parseGrepOutput(
      r.stdout,
      o.maxResults,
      o.include,
      o.exclude,
    );
    return { root, query, hits, truncated, source: "git-grep" };
  } catch {
    return null;
  }
}

function toGitPathspec(pattern: string, exclude: boolean): string {
  let p = pattern.replace(/\\/g, "/");
  if (!p.includes("/") && !p.includes("*")) {
    p = `**/${p}/**`;
  } else if (p.startsWith("*.") || (p.startsWith("*") && !p.startsWith("**"))) {
    p = `**/${p}`;
  }
  return exclude ? `:(exclude,glob)${p}` : `:(glob)${p}`;
}

async function tryRipgrep(
  host: HostSession,
  root: string,
  query: string,
  o: ReturnType<typeof normalizeOpts>,
): Promise<ContentSearchResult | null> {
  try {
    const args = [
      "-n",
      "-I",
      "--no-heading",
      "--color",
      "never",
      // Skip hidden by default (faster); .git already excluded via glob
      "--glob",
      "!.git/**",
      "--max-filesize",
      "512K",
      "--max-count",
      "8",
      // Stop after enough matches overall (rg 13+)
      "-m",
      String(Math.min(o.maxResults, 200)),
    ];
    // Some rg builds use --max-count for per-file only; also pass head-limit if available
    // --max-columns avoids huge lines
    args.push("--max-columns", "300", "--max-columns-preview");

    if (!o.useRegex) args.push("-F");
    if (!o.caseSensitive) args.push("-i");

    for (const ex of o.exclude) {
      args.push("--glob", `!${normalizeRgGlob(ex)}`);
    }
    if (o.include.length > 0) {
      for (const inc of o.include) {
        args.push("--glob", normalizeRgGlob(inc));
      }
    }

    args.push("--", query, ".");
    const r = await host.run(root, "rg", args, { timeoutMs: 15_000 });
    // 0 match, 1 no match, 2 error — also accept if stderr only complains about unknown flags
    if (r.code === 2 && /unrecognized|unknown/i.test(r.stderr)) {
      return tryRipgrepMinimal(host, root, query, o);
    }
    if (r.code !== 0 && r.code !== 1) return null;
    const { hits, truncated } = parseGrepOutput(
      r.stdout,
      o.maxResults,
      o.include,
      o.exclude,
    );
    return { root, query, hits, truncated, source: "rg" };
  } catch {
    return null;
  }
}

/** Older rg without some flags. */
async function tryRipgrepMinimal(
  host: HostSession,
  root: string,
  query: string,
  o: ReturnType<typeof normalizeOpts>,
): Promise<ContentSearchResult | null> {
  try {
    const args = [
      "-n",
      "-I",
      "--no-heading",
      "--color",
      "never",
      "--glob",
      "!.git/**",
      "--max-count",
      "8",
    ];
    if (!o.useRegex) args.push("-F");
    if (!o.caseSensitive) args.push("-i");
    for (const ex of o.exclude) {
      args.push("--glob", `!${normalizeRgGlob(ex)}`);
    }
    if (o.include.length > 0) {
      for (const inc of o.include) {
        args.push("--glob", normalizeRgGlob(inc));
      }
    }
    args.push("--", query, ".");
    const r = await host.run(root, "rg", args, { timeoutMs: 15_000 });
    if (r.code !== 0 && r.code !== 1) return null;
    const { hits, truncated } = parseGrepOutput(
      r.stdout,
      o.maxResults,
      o.include,
      o.exclude,
    );
    return { root, query, hits, truncated, source: "rg" };
  } catch {
    return null;
  }
}

function normalizeRgGlob(pattern: string): string {
  let p = pattern.replace(/\\/g, "/");
  if (!p.includes("/") && !p.includes("*")) {
    return `**/${p}/**`;
  }
  if (p.startsWith("*.") || (p.startsWith("*") && !p.startsWith("**"))) {
    return `**/${p}`;
  }
  return p;
}

async function scanFiles(
  host: HostSession,
  root: string,
  query: string,
  o: ReturnType<typeof normalizeOpts>,
): Promise<ContentSearchResult> {
  const index = await findWorkspaceFiles(host, root, {
    maxFiles: SCAN_MAX_FILES,
  });

  let matcher: (line: string) => boolean;
  if (o.useRegex) {
    const re = new RegExp(query, o.caseSensitive ? "" : "i");
    matcher = (line) => re.test(line);
  } else {
    const needle = o.caseSensitive ? query : query.toLowerCase();
    matcher = (line) => {
      const hay = o.caseSensitive ? line : line.toLowerCase();
      return hay.includes(needle);
    };
  }

  const candidates = index.files
    .map((rel) => rel.replace(/\\/g, "/"))
    .filter(
      (norm) =>
        pathMatchesGlobs(norm, o.include, o.exclude) &&
        !isProbablyBinaryPath(norm),
    );

  const hits: ContentSearchHit[] = [];
  let truncated = index.truncated;
  let next = 0;

  async function worker() {
    while (hits.length < o.maxResults) {
      const i = next++;
      if (i >= candidates.length) return;
      const norm = candidates[i]!;
      const abs = hostJoin(host.kind, root, norm);
      try {
        const st = await host.stat(abs);
        if (!st.isFile || st.size <= 0 || st.size > SCAN_MAX_FILE_BYTES) continue;
        const text = await host.readFile(abs);
        // Quick reject whole file before splitting lines
        if (!o.useRegex) {
          const blob = o.caseSensitive ? text : text.toLowerCase();
          const needle = o.caseSensitive ? query : query.toLowerCase();
          if (!blob.includes(needle)) continue;
        } else if (!new RegExp(query, o.caseSensitive ? "m" : "im").test(text)) {
          continue;
        }
        const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
        let perFile = 0;
        for (let li = 0; li < lines.length; li++) {
          if (hits.length >= o.maxResults) {
            truncated = true;
            return;
          }
          const line = lines[li] ?? "";
          if (!matcher(line)) continue;
          hits.push({
            path: norm,
            line: li + 1,
            text: line.length > 240 ? `${line.slice(0, 240)}…` : line,
          });
          perFile += 1;
          if (perFile >= 8) break;
        }
      } catch {
        // skip
      }
    }
    truncated = true;
  }

  const n = Math.min(SCAN_CONCURRENCY, Math.max(1, candidates.length));
  await Promise.all(Array.from({ length: n }, () => worker()));

  if (hits.length >= o.maxResults) truncated = true;
  // stable-ish order by path then line
  hits.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);

  return { root, query, hits, truncated, source: "scan" };
}

function isProbablyBinaryPath(rel: string): boolean {
  const lower = rel.toLowerCase();
  return /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|7z|rar|exe|dll|so|dylib|wasm|mp[34]|webm|woff2?|ttf|otf|eot|class|o|a|lib|pdb|bin|dat|lock)$/i.test(
    lower,
  );
}
