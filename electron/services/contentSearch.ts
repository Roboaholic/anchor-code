import type { HostSession, RunResult } from "../host/types.js";
import { LocalHostSession } from "../host/localHost.js";
import { WslHostSession } from "../host/wslHost.js";
import { hostJoin } from "../host/paths.js";
import { findWorkspaceFiles } from "./fileIndex.js";
import {
  resolveLocalRgPath,
  resolveWslLinuxRgPath,
} from "./rgPath.js";

/** Shared LocalHost only for spawning Windows tools (e.g. rg over \\wsl$\). */
let windowsRunner: LocalHostSession | null = null;
function getWindowsRunner(): LocalHostSession {
  if (!windowsRunner) windowsRunner = new LocalHostSession("content-search-win");
  return windowsRunner;
}

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
  /**
   * Progressive hits (batch per stdout chunk / per file for scan).
   * Lets the UI show results before the search process exits.
   */
  onHits?: (hits: ContentSearchHit[]) => void;
  /** Fired once when the engine is chosen (rg / git-grep / scan). */
  onSource?: (source: ContentSearchResult["source"]) => void;
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

/**
 * Built-in excludes (language/tooling conventions — not project-specific names).
 * Users can still search excluded trees via explicit include, or workspace filters.
 */
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
  ".cache",
  ".turbo",
  ".parcel-cache",
  "Pods",
  "DerivedData",
];

/** Extra rg globs always applied (binary / object noise — extension-based only). */
const DEFAULT_RG_GLOBS = [
  "!**/*.{o,a,so,dylib,dll,lib,exe,bin,elf,obj,pdb,pyc,pyo,class,jar,wasm}",
  "!**/*.{png,jpg,jpeg,gif,webp,ico,bmp,pdf,zip,gz,7z,rar,mp3,mp4,webm,woff,woff2,ttf,otf}",
  "!**/*.{lock,min.js,min.css,map}",
];


/**
 * rg command resolution cache:
 * - key `local` for LocalHost (absolute path or `"rg"`)
 * - key `host:<id>` for WSL/SSH remote `rg`
 * value `false` means unavailable
 */
const rgCmdCache = new Map<string, string | false>();

/** git-grep availability per workspace root. */
const gitCache = new Map<string, boolean | null>();

function rgCacheKey(host: HostSession): string {
  return host.kind === "local" ? "local" : `host:${host.id}`;
}

/**
 * Resolve the rg executable to spawn.
 * Local: bundled @vscode/ripgrep first, then PATH name `rg`.
 * Remote: remote PATH `rg` only (Windows binary cannot run in WSL/SSH Linux).
 */
function resolveRgCommand(host: HostSession): string | null {
  const key = rgCacheKey(host);
  const cached = rgCmdCache.get(key);
  if (cached === false) return null;
  if (typeof cached === "string") return cached;

  if (host.kind === "local") {
    const bundled = resolveLocalRgPath();
    if (bundled) {
      rgCmdCache.set(key, bundled);
      return bundled;
    }
    // Let tryRipgrep attempt PATH once; failure marks cache false.
    return "rg";
  }

  return "rg";
}

function markRgUnavailable(host: HostSession): void {
  rgCmdCache.set(rgCacheKey(host), false);
}

function markRgOk(host: HostSession, cmd: string): void {
  rgCmdCache.set(rgCacheKey(host), cmd);
}

/**
 * Split a user-facing include/exclude field into patterns.
 * Supports comma, semicolon, and whitespace separators.
 */
export function splitPatterns(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  const parts = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const part of parts) {
    if (typeof part !== "string") continue;
    // Workspace exclude paths may contain no separators; search UI fields
    // may list several globs separated by comma/space.
    if (/[,;\n]/.test(part) || (/\s/.test(part) && /[*?]/.test(part))) {
      for (const p of part.split(/[,;\n]+|\s+/)) {
        const t = p.trim();
        if (t) out.push(t);
      }
    } else {
      const t = part.trim();
      if (t) out.push(t);
    }
  }
  return out;
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

/**
 * Whether a relative path is allowed given include/exclude globs.
 * Plain (non-glob) exclude patterns match the path itself and all descendants
 * (so workspace "Exclude folder" also drops search hits under that folder).
 */
export function pathMatchesGlobs(
  relPath: string,
  include: string[],
  exclude: string[],
): boolean {
  const path = relPath.replace(/\\/g, "/");
  for (const ex of exclude) {
    const e = ex.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "").replace(/\/+$/, "");
    if (!e) continue;
    // Plain path: prefix match (file or directory tree).
    if (!/[*?]/.test(e)) {
      if (path === e || path.startsWith(`${e}/`)) return false;
      // Single segment also matches any path component (node_modules, dist, …).
      if (!e.includes("/") && path.split("/").includes(e)) return false;
      continue;
    }
    if (globToRegExp(e).test(path)) return false;
  }
  if (include.length === 0) return true;
  return include.some((inc) => {
    const i = inc.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "").replace(/\/+$/, "");
    if (!i) return false;
    if (!/[*?]/.test(i)) {
      return path === i || path.startsWith(`${i}/`);
    }
    return globToRegExp(i).test(path);
  });
}

/**
 * Parse `path:line:text` lines from git-grep / ripgrep.
 */
export function parseGrepLine(line: string): ContentSearchHit | null {
  const raw = line.replace(/\r$/, "");
  if (!raw) return null;
  const m = raw.match(/^(.*?):(\d+):(.*)$/);
  if (!m) return null;
  // rg on Windows often emits `.\foo\bar.ts` or `./foo/bar.ts`
  const path = (m[1] ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
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

/** True once enough filtered hits exist in stdout (for process early-kill). */
export function hasEnoughGrepHits(
  stdout: string,
  maxResults: number,
  include: string[],
  exclude: string[],
): boolean {
  return parseGrepOutput(stdout, maxResults, include, exclude).hits.length >= maxResults;
}

/**
 * Incremental hit counter for streaming stdout — avoids re-parsing the whole
 * buffer on every chunk (O(n) total instead of O(n²)).
 */
export function createGrepHitCounter(
  maxResults: number,
  include: string[],
  exclude: string[],
): (stdout: string) => boolean {
  return createGrepHitStreamer(maxResults, include, exclude).feed;
}

/**
 * Stream parse path:line:text from growing stdout; emit new hits as they appear.
 * `feed(stdout)` returns true once maxResults is reached (for early process kill).
 */
export function createGrepHitStreamer(
  maxResults: number,
  include: string[],
  exclude: string[],
  onHits?: (hits: ContentSearchHit[]) => void,
): {
  feed: (stdout: string) => boolean;
  hits: () => ContentSearchHit[];
} {
  let processedLen = 0;
  let carry = "";
  const all: ContentSearchHit[] = [];
  return {
    hits: () => all,
    feed: (stdout: string) => {
      if (all.length >= maxResults) return true;
      const chunk = carry + stdout.slice(processedLen);
      processedLen = stdout.length;
      const lines = chunk.split("\n");
      carry = lines.pop() ?? "";
      const batch: ContentSearchHit[] = [];
      for (const line of lines) {
        if (all.length >= maxResults) break;
        const hit = parseGrepLine(line);
        if (!hit) continue;
        if (!pathMatchesGlobs(hit.path, include, exclude)) continue;
        all.push(hit);
        batch.push(hit);
      }
      if (batch.length > 0) onHits?.(batch);
      return all.length >= maxResults;
    },
  };
}

function attachGrepStream(
  o: ReturnType<typeof normalizeOpts>,
  onHits: ((hits: ContentSearchHit[]) => void) | undefined,
  timeoutMs: number,
  /** Shared stop for parallel workers (global hit budget reached). */
  shouldStop?: () => boolean,
): {
  runOpts: import("../host/types.js").RunOptions;
  streamer: ReturnType<typeof createGrepHitStreamer>;
} {
  const streamer = createGrepHitStreamer(
    o.maxResults,
    o.include,
    o.exclude,
    onHits,
  );
  return {
    streamer,
    runOpts: {
      timeoutMs,
      earlyExit: (stdout) => {
        const full = streamer.feed(stdout);
        return full || Boolean(shouldStop?.());
      },
    },
  };
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
 * Prefer bundled/system ripgrep, then git grep (tracked files), then bounded parallel scan.
 * When `opts.onHits` is set, hits are streamed as they appear (before process exit).
 */
export async function searchWorkspaceContent(
  host: HostSession,
  root: string,
  query: string,
  opts?: ContentSearchOptions,
): Promise<ContentSearchResult> {
  const q = query.trim();
  const o = normalizeOpts(opts);
  const onHits = opts?.onHits;
  const onSource = opts?.onSource;
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

  // ripgrep first — bundled binary on local / Windows-rg over WSL UNC.
  const viaRg = await tryRipgrep(host, root, q, o, onHits, onSource);
  if (viaRg) return viaRg;

  const gitState = gitCache.get(root);
  if (gitState !== false) {
    const viaGit = await tryGitGrep(host, root, q, o, onHits, onSource);
    if (viaGit) {
      gitCache.set(root, true);
      return viaGit;
    }
    gitCache.set(root, false);
  }

  onSource?.("scan");
  return scanFiles(host, root, q, o, onHits);
}

async function tryGitGrep(
  host: HostSession,
  root: string,
  query: string,
  o: ReturnType<typeof normalizeOpts>,
  onHits?: (hits: ContentSearchHit[]) => void,
  onSource?: (source: ContentSearchResult["source"]) => void,
): Promise<ContentSearchResult | null> {
  try {
    // Fast path: tracked index only (no --untracked — that walks the whole tree).
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

    onSource?.("git-grep");
    const { runOpts, streamer } = attachGrepStream(o, onHits, 20_000);
    const r = await host.run(root, "git", args, runOpts);
    if (r.code !== 0 && r.code !== 1 && !r.earlyExit) return null;
    // Final parse catches any trailing incomplete line after kill.
    streamer.feed(r.stdout.endsWith("\n") ? r.stdout : `${r.stdout}\n`);
    const hits = streamer.hits();
    return {
      root,
      query,
      hits,
      truncated: hits.length >= o.maxResults || Boolean(r.earlyExit),
      source: "git-grep",
    };
  } catch {
    return null;
  }
}

function toGitPathspec(pattern: string, exclude: boolean): string {
  let p = pattern
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (!p.includes("*") && !p.includes("?")) {
    // Plain path: tree under this prefix (post-filter also enforces).
    if (!p.includes("/")) p = `**/${p}/**`;
    else p = `${p}/**`;
  } else if (p.startsWith("*.") || (p.startsWith("*") && !p.startsWith("**"))) {
    p = `**/${p}`;
  }
  return exclude ? `:(exclude,glob)${p}` : `:(glob)${p}`;
}

/** Build standard rg argv (without the executable). */
function buildRgArgs(
  query: string,
  o: ReturnType<typeof normalizeOpts>,
  minimal = false,
  /** Search roots relative to cwd; default `.`. Order matters (first = sooner hits). */
  searchPaths: string[] = ["."],
): string[] {
  // NOTE: do NOT pass `-I` — in ripgrep that means --no-filename (not
  // "ignore binary" like git-grep). rg skips binary by default; force paths
  // with -H so parseGrepLine always sees path:line:text.
  const args = [
    "-n",
    "-H",
    "--no-heading",
    "--color",
    "never",
    // Piped stdout is fully buffered by default — without this the UI
    // only receives hits after rg exits (feels like "wait for full scan").
    "--line-buffered",
    "--glob",
    "!.git/**",
    "--max-count",
    "8",
  ];
  if (!minimal) {
    args.push(
      "--max-filesize",
      "512K",
      "--max-columns",
      "300",
      "--max-columns-preview",
    );
    for (const g of DEFAULT_RG_GLOBS) {
      args.push("--glob", g);
    }
  }
  if (!o.useRegex) args.push("-F");
  if (!o.caseSensitive) args.push("-i");
  for (const ex of o.exclude) {
    for (const g of rgExcludeGlobs(ex)) {
      args.push("--glob", `!${g}`);
    }
  }
  if (o.include.length > 0) {
    for (const inc of o.include) {
      args.push("--glob", normalizeRgGlob(inc));
    }
  }
  const paths = searchPaths.length > 0 ? searchPaths : ["."];
  args.push("--", query, ...paths);
  return args;
}


function finishGrepStream(
  root: string,
  query: string,
  r: RunResult,
  o: ReturnType<typeof normalizeOpts>,
  streamer: ReturnType<typeof createGrepHitStreamer>,
  source: ContentSearchResult["source"],
): ContentSearchResult {
  // Flush trailing partial line after process exit.
  streamer.feed(r.stdout.endsWith("\n") ? r.stdout : `${r.stdout}\n`);
  const hits = streamer.hits();
  return {
    root,
    query,
    hits,
    truncated: hits.length >= o.maxResults || Boolean(r.earlyExit),
    source,
  };
}

/**
 * WSL: run a *Linux* rg binary *inside* the distro (native FS).
 * Prefer bundled linux-x64 rg exposed via /mnt/c/…; fall back to PATH `rg`.
 * This is dramatically faster than Windows rg over \\wsl$\ (9P).
 */
async function tryRipgrepWslNative(
  host: HostSession,
  root: string,
  query: string,
  o: ReturnType<typeof normalizeOpts>,
  onHits?: (hits: ContentSearchHit[]) => void,
  onSource?: (source: ContentSearchResult["source"]) => void,
  searchPaths: string[] = ["."],
  shouldStop?: () => boolean,
): Promise<ContentSearchResult | null> {
  if (host.kind !== "wsl") return null;

  const cacheKey = `wsl-native:${host.id}`;
  if (rgCmdCache.get(cacheKey) === false) return null;

  const bundled = process.platform === "win32" ? resolveWslLinuxRgPath() : null;
  // Bundled path first; then PATH inside the distro.
  const candidates = bundled ? [bundled, "rg"] : ["rg"];

  for (const rgCmd of candidates) {
    try {
      // Ensure execute bit when invoking a /mnt/c binary (drvfs often drops +x).
      if (rgCmd.startsWith("/mnt/")) {
        await host.run(root, "chmod", ["+x", rgCmd], { timeoutMs: 5_000 }).catch(
          () => null,
        );
      }
      onSource?.("rg");
      const { runOpts, streamer } = attachGrepStream(
        o,
        onHits,
        45_000,
        shouldStop,
      );
      const r = await host.run(
        root,
        rgCmd,
        buildRgArgs(query, o, false, searchPaths),
        runOpts,
      );
      if (r.code === 2 && /unrecognized|unknown/i.test(r.stderr)) {
        const again = attachGrepStream(o, onHits, 45_000, shouldStop);
        const r2 = await host.run(
          root,
          rgCmd,
          buildRgArgs(query, o, true, searchPaths),
          again.runOpts,
        );
        if (r2.code === 0 || r2.code === 1 || r2.earlyExit) {
          rgCmdCache.set(cacheKey, rgCmd);
          return finishGrepStream(root, query, r2, o, again.streamer, "rg");
        }
        continue;
      }
      if (r.code === 0 || r.code === 1 || r.earlyExit) {
        rgCmdCache.set(cacheKey, rgCmd);
        return finishGrepStream(root, query, r, o, streamer, "rg");
      }
      // 127 = command not found; try next candidate
      if (r.code === 127 || /not found|No such file/i.test(r.stderr)) {
        continue;
      }
    } catch {
      continue;
    }
  }

  rgCmdCache.set(cacheKey, false);
  return null;
}

/**
 * WSL fallback: Windows rg against \\wsl$\… (slow 9P — last resort before scan).
 */
async function tryRipgrepWslUnc(
  host: HostSession,
  root: string,
  query: string,
  o: ReturnType<typeof normalizeOpts>,
  onHits?: (hits: ContentSearchHit[]) => void,
  onSource?: (source: ContentSearchResult["source"]) => void,
  searchPaths: string[] = ["."],
  shouldStop?: () => boolean,
): Promise<ContentSearchResult | null> {
  if (host.kind !== "wsl" || process.platform !== "win32") return null;
  if (!(host instanceof WslHostSession)) return null;

  const cacheKey = `wsl-unc:${host.id}`;
  if (rgCmdCache.get(cacheKey) === false) return null;

  const rgCmd = resolveLocalRgPath() ?? "rg";
  let uncRoot: string;
  try {
    uncRoot = await host.toWindowsUnc(root);
  } catch {
    rgCmdCache.set(cacheKey, false);
    return null;
  }

  const runner = getWindowsRunner();

  try {
    onSource?.("rg");
    let stream = attachGrepStream(o, onHits, 20_000, shouldStop);
    let r = await runner.run(
      uncRoot,
      rgCmd,
      buildRgArgs(query, o, false, searchPaths),
      stream.runOpts,
    );
    if (r.code === 2 && /unrecognized|unknown/i.test(r.stderr)) {
      stream = attachGrepStream(o, onHits, 20_000, shouldStop);
      r = await runner.run(
        uncRoot,
        rgCmd,
        buildRgArgs(query, o, true, searchPaths),
        stream.runOpts,
      );
    }
    if (r.code !== 0 && r.code !== 1 && !r.earlyExit) {
      if (
        /cannot find|ENOENT|not supported|network path|timed out/i.test(
          r.stderr || r.stdout,
        )
      ) {
        rgCmdCache.set(cacheKey, false);
      }
      return null;
    }
    rgCmdCache.set(cacheKey, rgCmd);
    return finishGrepStream(root, query, r, o, stream.streamer, "rg");
  } catch {
    rgCmdCache.set(cacheKey, false);
    return null;
  }
}

/**
 * Ripgrep over the whole tree. Starts immediately (no listDir wait) so the
 * first match can stream to the UI as soon as rg prints a line.
 * `--line-buffered` is required — piped stdout is fully buffered otherwise.
 */
async function tryRipgrep(
  host: HostSession,
  root: string,
  query: string,
  o: ReturnType<typeof normalizeOpts>,
  onHits?: (hits: ContentSearchHit[]) => void,
  onSource?: (source: ContentSearchResult["source"]) => void,
): Promise<ContentSearchResult | null> {
  return runRipgrepOnce(host, root, query, o, onHits, onSource, ["."]);
}


/** One ripgrep invocation over the given relative paths (local / WSL / UNC). */
async function runRipgrepOnce(
  host: HostSession,
  root: string,
  query: string,
  o: ReturnType<typeof normalizeOpts>,
  onHits?: (hits: ContentSearchHit[]) => void,
  onSource?: (source: ContentSearchResult["source"]) => void,
  searchPaths: string[] = ["."],
  shouldStop?: () => boolean,
): Promise<ContentSearchResult | null> {
  // WSL: native Linux rg first (fast), UNC Windows rg only as last rg fallback.
  if (host.kind === "wsl") {
    const viaNative = await tryRipgrepWslNative(
      host,
      root,
      query,
      o,
      onHits,
      onSource,
      searchPaths,
      shouldStop,
    );
    if (viaNative) return viaNative;
    const viaUnc = await tryRipgrepWslUnc(
      host,
      root,
      query,
      o,
      onHits,
      onSource,
      searchPaths,
      shouldStop,
    );
    if (viaUnc) return viaUnc;
    return null;
  }

  const rgCmd = resolveRgCommand(host);
  if (!rgCmd) return null;

  try {
    onSource?.("rg");
    const { runOpts, streamer } = attachGrepStream(
      o,
      onHits,
      15_000,
      shouldStop,
    );
    const r = await host.run(
      root,
      rgCmd,
      buildRgArgs(query, o, false, searchPaths),
      runOpts,
    );
    // 0 match, 1 no match, 2 error — also accept if stderr only complains about unknown flags
    if (r.code === 2 && /unrecognized|unknown/i.test(r.stderr)) {
      return tryRipgrepMinimal(
        host,
        root,
        query,
        o,
        rgCmd,
        onHits,
        onSource,
        searchPaths,
        shouldStop,
      );
    }
    if (r.code !== 0 && r.code !== 1 && !r.earlyExit) {
      // Missing binary / hard failure
      if (
        r.code === 127 ||
        /not found|ENOENT|is not recognized/i.test(r.stderr)
      ) {
        markRgUnavailable(host);
      }
      return null;
    }
    markRgOk(host, rgCmd);
    return finishGrepStream(root, query, r, o, streamer, "rg");
  } catch {
    // spawn ENOENT etc.
    markRgUnavailable(host);
    return null;
  }
}

/** Older rg without some flags. */
async function tryRipgrepMinimal(
  host: HostSession,
  root: string,
  query: string,
  o: ReturnType<typeof normalizeOpts>,
  rgCmd: string,
  onHits?: (hits: ContentSearchHit[]) => void,
  onSource?: (source: ContentSearchResult["source"]) => void,
  searchPaths: string[] = ["."],
  shouldStop?: () => boolean,
): Promise<ContentSearchResult | null> {
  try {
    onSource?.("rg");
    const { runOpts, streamer } = attachGrepStream(
      o,
      onHits,
      15_000,
      shouldStop,
    );
    const r = await host.run(
      root,
      rgCmd,
      buildRgArgs(query, o, true, searchPaths),
      runOpts,
    );
    if (r.code !== 0 && r.code !== 1 && !r.earlyExit) {
      markRgUnavailable(host);
      return null;
    }
    markRgOk(host, rgCmd);
    return finishGrepStream(root, query, r, o, streamer, "rg");
  } catch {
    markRgUnavailable(host);
    return null;
  }
}

function normalizeRgGlob(pattern: string): string {
  let p = pattern
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (!p.includes("*") && !p.includes("?")) {
    // Single name → anywhere; multi-segment plain path → that tree.
    if (!p.includes("/")) return `**/${p}/**`;
    return `${p}/**`;
  }
  if (p.startsWith("*.") || (p.startsWith("*") && !p.startsWith("**"))) {
    return `**/${p}`;
  }
  return p;
}

/** Emit one or more rg --glob values (without leading !). */
function rgExcludeGlobs(pattern: string): string[] {
  const p = pattern
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (!p) return [];
  if (!/[*?]/.test(p)) {
    if (!p.includes("/")) return [`**/${p}/**`, `**/${p}`];
    return [p, `${p}/**`];
  }
  return [normalizeRgGlob(p)];
}

async function scanFiles(
  host: HostSession,
  root: string,
  query: string,
  o: ReturnType<typeof normalizeOpts>,
  onHits?: (hits: ContentSearchHit[]) => void,
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
        const fileBatch: ContentSearchHit[] = [];
        for (let li = 0; li < lines.length; li++) {
          if (hits.length >= o.maxResults) {
            truncated = true;
            if (fileBatch.length) onHits?.(fileBatch);
            return;
          }
          const line = lines[li] ?? "";
          if (!matcher(line)) continue;
          const hit: ContentSearchHit = {
            path: norm,
            line: li + 1,
            text: line.length > 240 ? `${line.slice(0, 240)}…` : line,
          };
          hits.push(hit);
          fileBatch.push(hit);
          perFile += 1;
          if (perFile >= 8) break;
        }
        if (fileBatch.length) onHits?.(fileBatch);
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
