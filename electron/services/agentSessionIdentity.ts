import { createHash } from "node:crypto";
import type { HostSession } from "../host/types.js";
import { resolveHostHome } from "./skillInstall.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export const AGENT_SESSION_CAPTURE_TIMEOUT_MS = 5 * 60_000;
export const AGENT_SESSION_SCAN_TIMEOUT_MS = 8_000;

export function sessionIdPattern(profileId: string): RegExp | null {
  switch (profileId.trim().toLowerCase()) {
    case "omp":
    case "pi":
      return new RegExp(`\\"type\\":\\"session\\"[^\\n]*?\\"id\\":\\"(${UUID})\\"`, "gi");
    case "codex":
      // Older rollouts: "session_id"; newer session_meta lines: {"type":"session_meta","payload":{"id":…}}.
      return new RegExp(
        `\\"session_id\\":\\"(${UUID})\\"|\\"type\\":\\"session_meta\\"[^\\n]*?\\"id\\":\\"(${UUID})\\"`,
        "gi",
      );
    case "claude":
    case "gemini":
      return new RegExp(`\\"sessionId\\":\\"(${UUID})\\"`, "gi");
    default:
      return null;
  }
}

const UUID_PATTERN = new RegExp(UUID, "gi");

export function sessionIdsFromPaths(text: string): Set<string> {
  return new Set(text.match(UUID_PATTERN)?.map((id) => id.toLowerCase()) ?? []);
}

/** Session ids from transcript file names (`<uuid>.jsonl`, `rollout-…-<uuid>.jsonl`). */
export function sessionIdsFromFileNames(text: string): Set<string> {
  const ids = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const base = line.trim().split(/[\\/]/).pop() ?? "";
    const m = base.match(new RegExp(`(${UUID})\\.jsonl$`, "i"));
    if (m?.[1]) ids.add(m[1].toLowerCase());
  }
  return ids;
}

/** CLIs whose transcript file name carries the session id. */
function namesCarrySessionId(profileId: string): boolean {
  const id = profileId.trim().toLowerCase();
  // pi: <ts>_<uuid>.jsonl
  return id === "claude" || id === "codex" || id === "pi";
}

export interface AgentSessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  /** Working directory the session ran in, when the transcript records it. */
  cwd?: string;
}

/**
 * Directory a transcript ran in. Codex (`session_meta.payload.cwd`), Claude
 * (`cwd` on every message line), pi / OMP (`cwd` on the `session` header);
 * older Codex rollouts only carry `<cwd>…</cwd>` inside `<environment_context>`.
 * Gemini records no cwd (only `projectHash`), so it returns null.
 */
export function parseAgentSessionCwd(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes("cwd")) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      const payload = record.payload && typeof record.payload === "object"
        ? record.payload as Record<string, unknown>
        : null;
      const cwd = typeof record.cwd === "string"
        ? record.cwd
        : typeof payload?.cwd === "string"
          ? payload.cwd
          : null;
      if (cwd?.trim()) return cwd.trim();
    } catch {
      // Ignore partially written JSONL lines.
    }
  }
  const legacy = text.match(/<cwd>([^<]+)<\/cwd>/);
  if (legacy?.[1]) {
    try {
      return (JSON.parse(`"${legacy[1]}"`) as string).trim() || null;
    } catch {
      return legacy[1].trim() || null;
    }
  }
  return null;
}

function parseGeminiProjectHash(text: string): string | null {
  return text.match(/"projectHash"\s*:\s*"([0-9a-f]{64})"/i)?.[1]?.toLowerCase() ?? null;
}

/** Gemini CLI keys sessions by sha256(project root) instead of recording a cwd. */
export function geminiProjectHash(root: string): string {
  return createHash("sha256").update(root).digest("hex");
}

function normalizeSessionPath(value: string, caseInsensitive: boolean): string {
  let out = value.trim().replace(/\\/g, "/");
  const unc = out.startsWith("//");
  out = out.replace(/\/{2,}/g, "/");
  if (unc) out = `/${out}`;
  if (out.length > 1 && !/^[a-z]:\/$/i.test(out)) out = out.replace(/\/+$/, "");
  if (/^[a-z]:/i.test(out) || caseInsensitive) out = out.toLowerCase();
  return out;
}

/** True when `cwd` is `root` or a directory below it (separator- and case-aware). */
export function isPathWithin(cwd: string, root: string, caseInsensitive = false): boolean {
  const child = normalizeSessionPath(cwd, caseInsensitive);
  const parent = normalizeSessionPath(root, caseInsensitive);
  if (!child || !parent) return false;
  if (child === parent) return true;
  return child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

export interface SessionWorkspaceFilter {
  root: string;
  caseInsensitive?: boolean;
}

/**
 * Keep sessions that ran in the workspace root or below it. Sessions without
 * any cwd metadata are dropped: we cannot tell which project they belong to.
 */
export function sessionInWorkspace(
  profileId: string,
  session: { cwd?: string; filePath?: string; projectHash?: string | null },
  filter: SessionWorkspaceFilter,
): boolean {
  if (session.cwd) return isPathWithin(session.cwd, filter.root, filter.caseInsensitive);
  if (profileId.trim().toLowerCase() === "gemini") {
    const hash = geminiProjectHash(filter.root);
    return session.projectHash === hash || Boolean(session.filePath?.toLowerCase().includes(hash));
  }
  return false;
}

/** Strings a matching transcript must contain (cheap grep before parsing). */
export function sessionScanNeedles(profileId: string, root: string): string[] {
  const needles = new Set<string>();
  const trimmed = root.replace(/[\\/]+$/, "") || root;
  needles.add(JSON.stringify(trimmed).slice(1, -1));
  needles.add(trimmed.replace(/\\/g, "/"));
  needles.add(trimmed);
  if (profileId.trim().toLowerCase() === "gemini") needles.add(geminiProjectHash(root));
  return [...needles].filter(Boolean);
}

function sessionRoot(home: string, profileId: string): string | null {
  const root = home.replace(/[\\/]+$/, "");
  switch (profileId.trim().toLowerCase()) {
    case "omp": return `${root}/.omp/agent/sessions`;
    case "pi": return `${root}/.pi/agent/sessions`;
    case "codex": return `${root}/.codex/sessions`;
    case "claude": return `${root}/.claude/projects`;
    case "gemini": return `${root}/.gemini/tmp`;
    default: return null;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function cleanTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 120) : null;
}

function messageText(value: unknown): string | null {
  if (typeof value === "string") return cleanTitle(value);
  if (!Array.isArray(value)) return null;
  return cleanTitle(value.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const text = (part as Record<string, unknown>).text;
    return typeof text === "string" ? [text] : [];
  }).join(" "));
}

function firstUserTitle(record: Record<string, unknown>): string | null {
  const message = record.message && typeof record.message === "object"
    ? record.message as Record<string, unknown>
    : record.payload && typeof record.payload === "object"
      ? record.payload as Record<string, unknown>
      : record;
  const role = message.role ?? message.type;
  if (role !== "user") return null;
  const text = messageText(message.content);
  if (!text || text.startsWith("# AGENTS.md instructions") || text.startsWith("<environment_context>")) return null;
  return text;
}

export function parseAgentSessionTitle(profileId: string, text: string): string | null {
  const id = profileId.trim().toLowerCase();
  let fallback: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (id === "omp" && record.type === "title") {
        const title = cleanTitle(record.title);
        if (title) return title;
      }
      const payload = record.payload && typeof record.payload === "object"
        ? record.payload as Record<string, unknown>
        : record;
      for (const key of ["customTitle", "sessionName", "session_name", "title", "name"] as const) {
        const title = cleanTitle(payload[key]);
        if (title) return title;
      }
      fallback ??= firstUserTitle(record);
    } catch {
      // Ignore partially written JSONL lines.
    }
  }
  return fallback;
}

export function parseAgentSessionList(
  profileId: string,
  text: string,
  filter?: SessionWorkspaceFilter | null,
): AgentSessionSummary[] {
  const pattern = sessionIdPattern(profileId);
  const sessions: AgentSessionSummary[] = [];
  for (const chunk of text.split("\x1e").slice(1)) {
    const end = chunk.indexOf("\x1f");
    const record = end >= 0 ? chunk.slice(0, end) : chunk;
    const newline = record.indexOf("\n");
    if (newline < 0) continue;
    const header = record.slice(0, newline).replace(/\r$/, "");
    const tab = header.indexOf("\t");
    if (tab < 0) continue;
    const modifiedSeconds = Number(header.slice(0, tab));
    const filePath = header.slice(tab + 1);
    const transcript = record.slice(newline + 1);
    const pathId = filePath.match(UUID_PATTERN)?.[0];
    const first = pattern ? [...transcript.matchAll(pattern)][0] : undefined;
    const contentId = first ? first[1] ?? first[2] : undefined;
    const id = (pathId ?? contentId)?.toLowerCase();
    if (!id) continue;
    const cwd = parseAgentSessionCwd(transcript) ?? undefined;
    if (
      filter &&
      !sessionInWorkspace(
        profileId,
        { cwd, filePath, projectHash: parseGeminiProjectHash(transcript) },
        filter,
      )
    ) continue;
    sessions.push({
      id,
      title: parseAgentSessionTitle(profileId, transcript) ?? `Session ${id.slice(0, 8)}`,
      updatedAt: Number.isFinite(modifiedSeconds)
        ? new Date(modifiedSeconds * 1_000).toISOString()
        : new Date(0).toISOString(),
      ...(cwd ? { cwd } : {}),
    });
  }
  return sessions;
}

function sessionSegments(profileId: string): string | null {
  switch (profileId.trim().toLowerCase()) {
    case "omp": return ".omp/agent/sessions";
    case "pi": return ".pi/agent/sessions";
    case "codex": return ".codex/sessions";
    case "claude": return ".claude/projects";
    case "gemini": return ".gemini/tmp";
    default: return null;
  }
}
function hostHomeCwd(host: HostSession): string {
  return host.kind === "local" ? process.cwd() : "/";
}


/** Newest transcripts inspected when scoping history to a workspace. */
export const AGENT_SESSION_WORKSPACE_SCAN_WINDOW = 400;

interface RecentScanOptions {
  /** Max transcripts emitted. */
  limit: number;
  /** Max newest transcripts inspected (>= limit). */
  window: number;
  /** When set, only transcripts whose path or first 128 lines contain one of these. */
  needles?: string[];
}

function posixRecentScanScript(rootExpr: string, opts: RecentScanOptions): string {
  const needles = opts.needles?.filter(Boolean) ?? [];
  const grepArgs = needles.map((n) => `-e ${shellQuote(n)}`).join(" ");
  const pathCase = needles.map((n) => `*${shellQuote(n)}*`).join("|");
  const keep = needles.length > 0
    ? `case "$file" in ${pathCase}) ;; *) head -n 128 "$file" 2>/dev/null | grep -qF ${grepArgs} || continue;; esac; `
    : "";
  return `root=${rootExpr}; if [ -d "$root" ]; then find "$root" -type f -name '*.jsonl' -printf '%T@\\t%p\\n' 2>/dev/null | sort -nr | head -n ${opts.window} | { n=0; while IFS="$(printf '\\t')" read -r mtime file; do ${keep}printf '\\036%s\\t%s\\n' "$mtime" "$file"; head -n 128 "$file"; printf '\\037\\n'; n=$((n+1)); [ "$n" -ge ${opts.limit} ] && break; done; }; fi`;
}

async function runRecentSessionScanFromHome(
  host: HostSession,
  profileId: string,
  opts: RecentScanOptions,
): Promise<string> {
  const segment = sessionSegments(profileId);
  if (!segment) return "";
  // Session files live under $HOME, so workspace validity is irrelevant.
  const cwd = hostHomeCwd(host);
  const script = posixRecentScanScript(`"$HOME/${segment}"`, opts);
  return (await host.run(cwd, "bash", ["-s"], {
    stdin: script,
    timeoutMs: AGENT_SESSION_SCAN_TIMEOUT_MS,
  })).stdout;
}

async function runRecentSessionScan(
  host: HostSession,
  root: string,
  opts: RecentScanOptions,
): Promise<string> {
  const cwd = host.workspaceRoot || (host.kind === "local" ? process.cwd() : "/");
  if (host.kind === "local" && process.platform === "win32") {
    const rootArg = powershellQuote(root.replace(/\//g, "\\\\"));
    const needles = opts.needles?.filter(Boolean) ?? [];
    const filter = needles.length > 0
      ? ` | Where-Object { $f = $_.FullName; $hit = $false; foreach ($n in $needles) { if ($f.IndexOf($n, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $hit = $true } }; $hit -or (Get-Content -LiteralPath $f -TotalCount 128 -ErrorAction SilentlyContinue | Select-String -SimpleMatch -Pattern $needles -Quiet) }`
      : "";
    const command = [
      `$root=${rootArg}`,
      `$needles=@(${needles.map(powershellQuote).join(",")})`,
      `if (Test-Path -LiteralPath $root) { Get-ChildItem -LiteralPath $root -Recurse -File -Filter *.jsonl -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First ${opts.window}${filter} | Select-Object -First ${opts.limit} | ForEach-Object { [Console]::Out.Write([char]30 + ([DateTimeOffset]$_.LastWriteTimeUtc).ToUnixTimeSeconds().ToString() + [char]9 + $_.FullName + [char]10); Get-Content -LiteralPath $_.FullName -TotalCount 128; [Console]::Out.Write([char]31 + [char]10) } }`,
    ].join("; ");
    return (await host.run(cwd, "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { timeoutMs: 8_000 })).stdout;
  }
  const script = posixRecentScanScript(shellQuote(root), opts);
  if (host.kind === "wsl" || host.kind === "ssh") {
    return (await host.run(cwd, "bash", ["-s"], { stdin: script, timeoutMs: 8_000 })).stdout;
  }
  return (await host.run(cwd, "sh", ["-lc", script], { timeoutMs: 8_000 })).stdout;
}

export interface ListAgentSessionsOptions {
  /**
   * Only sessions that ran in this directory or below it (host-native path:
   * remote POSIX path on SSH, Linux path on WSL). Null / omitted = all sessions.
   */
  workspaceRoot?: string | null;
}

export async function listAgentSessions(
  host: HostSession,
  profileId: string,
  limit = 12,
  options: ListAgentSessionsOptions = {},
): Promise<AgentSessionSummary[]> {
  if (!sessionIdPattern(profileId)) return [];
  const count = Math.min(30, Math.max(1, limit));
  const root = options.workspaceRoot?.trim() || null;
  const filter: SessionWorkspaceFilter | null = root
    ? {
        root,
        caseInsensitive:
          host.kind === "local" && (process.platform === "win32" || process.platform === "darwin"),
      }
    : null;
  const scan: RecentScanOptions = filter
    ? {
        // Prefilter over-matches (e.g. /repo vs /repo2); parse then trim.
        limit: count * 2 + 10,
        window: AGENT_SESSION_WORKSPACE_SCAN_WINDOW,
        needles: sessionScanNeedles(profileId, filter.root),
      }
    : { limit: count, window: count };
  const text = host.kind === "wsl" || host.kind === "ssh"
    ? await runRecentSessionScanFromHome(host, profileId, scan)
    : await (async () => {
        const home = await resolveHostHome(host);
        const sessionDir = sessionRoot(home, profileId);
        return sessionDir ? runRecentSessionScan(host, sessionDir, scan) : "";
      })();
  return parseAgentSessionList(profileId, text, filter).slice(0, count);
}

async function runSessionPathScan(
  host: HostSession,
  root: string,
  sinceMs?: number,
): Promise<string> {
  const cwd = hostHomeCwd(host);
  // Minutes window (+1 slack) for "modified since launch" filtering.
  const minutes = sinceMs !== undefined
    ? Math.max(1, Math.ceil((Date.now() - sinceMs) / 60_000) + 1)
    : null;
  if (host.kind === "local" && process.platform === "win32") {
    const rootArg = powershellQuote(root.replace(/\//g, "\\\\"));
    const since = minutes !== null
      ? ` | Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-${minutes}) }`
      : "";
    const command = `$root=${rootArg}; if (Test-Path -LiteralPath $root) { Get-ChildItem -LiteralPath $root -Recurse -File -Filter *.jsonl -ErrorAction SilentlyContinue${since} | ForEach-Object { $_.FullName } }`;
    return (await host.run(cwd, "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { timeoutMs: 8_000 })).stdout;
  }
  const since = minutes !== null ? ` -mmin -${minutes}` : "";
  const script = `if [ -d ${shellQuote(root)} ]; then find ${shellQuote(root)} -type f -name '*.jsonl'${since} -print 2>/dev/null; fi`;
  if (host.kind === "wsl" || host.kind === "ssh") {
    return (await host.run(cwd, "bash", ["-s"], { stdin: script, timeoutMs: 8_000 })).stdout;
  }
  return (await host.run(cwd, "sh", ["-lc", script], { timeoutMs: 8_000 })).stdout;
}

async function runSessionScan(host: HostSession, root: string, sessionId?: string): Promise<string> {
  const cwd = hostHomeCwd(host);
  if (host.kind === "local" && process.platform === "win32") {
    const rootArg = powershellQuote(root.replace(/\//g, "\\\\"));
    const idArg = powershellQuote(sessionId ?? "");
    const command = [
      `$root=${rootArg}`,
      `$id=${idArg}`,
      "if (Test-Path -LiteralPath $root) {",
      sessionId
        ? "Get-ChildItem -LiteralPath $root -Recurse -File -Filter *.jsonl -ErrorAction SilentlyContinue | Where-Object { $_.Name -like \"*$id*\" -or (Select-String -LiteralPath $_.FullName -SimpleMatch $id -Quiet) } | Select-Object -First 1 | ForEach-Object { Get-Content -LiteralPath $_.FullName -TotalCount 128 }"
        : "Get-ChildItem -LiteralPath $root -Recurse -File -Filter *.jsonl -ErrorAction SilentlyContinue | ForEach-Object { Get-Content -LiteralPath $_.FullName -TotalCount 2 }",
      "}",
    ].join("; ");
    return (await host.run(cwd, "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { timeoutMs: 8_000 })).stdout;
  }
  const rootArg = shellQuote(root);
  const idArg = shellQuote(sessionId ?? "");
  const script = sessionId
    ? `root=${rootArg}; id=${idArg}; file=$(find "$root" -type f -name "*$id*.jsonl" -print -quit 2>/dev/null); if [ -z "$file" ]; then file=$(grep -rl -m1 -F "\\\"id\\\":\\\"$id\\\"" "$root" --include='*.jsonl' 2>/dev/null | head -n 1); fi; if [ -n "$file" ]; then head -n 128 "$file"; fi`
    : `if [ -d ${rootArg} ]; then find ${rootArg} -type f -name '*.jsonl' -print 2>/dev/null | while IFS= read -r f; do head -n 2 "$f"; done; fi`;
  if (host.kind === "wsl" || host.kind === "ssh") {
    return (await host.run(cwd, "bash", ["-s"], { stdin: script, timeoutMs: 8_000 })).stdout;
  }
  return (await host.run(cwd, "sh", ["-lc", script], { timeoutMs: 8_000 })).stdout;
}

async function grokSessionIds(host: HostSession): Promise<Set<string>> {
  const cwd = hostHomeCwd(host);
  const script = "import{Database}from'bun:sqlite';import{homedir}from'node:os';import{join}from'node:path';try{const d=new Database(join(homedir(),'.grok','grok.db'),{readonly:true});console.log(d.query('select id from sessions').all().map(x=>x.id).join('\\n'))}catch{}";
  const result = await host.run(cwd, "bun", ["-e", script], { timeoutMs: 8_000 });
  return new Set(result.stdout.split(/\r?\n/).map((id) => id.trim()).filter(Boolean));
}

export async function listAgentSessionIds(host: HostSession, profileId: string): Promise<Set<string>> {
  const id = profileId.trim().toLowerCase();
  if (id === "grok") return grokSessionIds(host);
  const pattern = sessionIdPattern(profileId);
  if (!pattern) return new Set();
  const home = await resolveHostHome(host);
  const root = sessionRoot(home, profileId);
  if (!root) return new Set();
  if (id === "omp") {
    return sessionIdsFromPaths(await runSessionPathScan(host, root));
  }
  const ids = new Set<string>();
  let scanError: unknown = null;
  if (namesCarrySessionId(id)) {
    try {
      for (const sid of sessionIdsFromFileNames(await runSessionPathScan(host, root))) ids.add(sid);
    } catch (err) {
      scanError = err;
    }
  }
  try {
    for (const match of (await runSessionScan(host, root)).matchAll(pattern)) {
      const sid = match[1] ?? match[2];
      if (sid) ids.add(sid.toLowerCase());
    }
  } catch (err) {
    if (scanError || !namesCarrySessionId(id)) throw err;
  }
  return ids;
}

/**
 * Ids of transcripts written since `sinceMs` (claude / codex file names).
 * Null when the CLI has no id-bearing file names.
 */
export async function listRecentSessionFileIds(
  host: HostSession,
  profileId: string,
  sinceMs: number,
): Promise<Set<string> | null> {
  if (!namesCarrySessionId(profileId)) return null;
  const home = await resolveHostHome(host);
  const root = sessionRoot(home, profileId);
  if (!root) return null;
  return sessionIdsFromFileNames(await runSessionPathScan(host, root, sinceMs));
}

export function claimCreatedAgentSession(
  current: ReadonlySet<string>,
  before: ReadonlySet<string>,
  claim?: (sessionId: string) => boolean,
): string | null {
  for (const id of current) {
    if (before.has(id)) continue;
    if (!claim || claim(id)) return id;
  }
  return null;
}

export async function waitForCreatedAgentSession(
  host: HostSession,
  profileId: string,
  before: ReadonlySet<string>,
  timeoutMs = AGENT_SESSION_CAPTURE_TIMEOUT_MS,
  claim?: (sessionId: string) => boolean,
  /** Launch time; only transcripts written after it count (claude / codex). */
  sinceMs?: number,
): Promise<string | null> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  do {
    // Scan failures / timeouts (big transcript trees, slow SSH) are retried,
    // never fatal: a missed id means the session can't be resumed later.
    try {
      // Prefer transcripts created after launch (file name = id): immune to
      // first-line formats (plan mode, long prompts) and to a failed `before`.
      const recent = await listRecentSessionFileIds(host, profileId, sinceMs ?? startedAt);
      const fromFiles = recent ? claimCreatedAgentSession(recent, before, claim) : null;
      if (fromFiles) return fromFiles;
      if (!recent || recent.size === 0) {
        const current = await listAgentSessionIds(host, profileId);
        const created = claimCreatedAgentSession(current, before, claim);
        if (created) return created;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  } while (Date.now() < deadline);
  return null;
}

export async function readAgentSessionTitle(host: HostSession, profileId: string, sessionId: string): Promise<string | null> {
  if (profileId.trim().toLowerCase() === "grok") {
    const cwd = hostHomeCwd(host);
    const script = `import{Database}from'bun:sqlite';import{homedir}from'node:os';import{join}from'node:path';try{const d=new Database(join(homedir(),'.grok','grok.db'),{readonly:true});const r=d.query('select title from sessions where id = ?').get(${JSON.stringify(sessionId)});if(r?.title)console.log(r.title)}catch{}`;
    return cleanTitle((await host.run(cwd, "bun", ["-e", script], { timeoutMs: 8_000 })).stdout);
  }
  const home = await resolveHostHome(host);
  const root = sessionRoot(home, profileId);
  if (!root) return null;
  return parseAgentSessionTitle(profileId, await runSessionScan(host, root, sessionId));
}
