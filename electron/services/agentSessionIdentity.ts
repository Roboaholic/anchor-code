import type { HostSession } from "../host/types.js";
import { resolveHostHome } from "./skillInstall.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export const AGENT_SESSION_CAPTURE_TIMEOUT_MS = 5 * 60_000;
export const AGENT_SESSION_SCAN_TIMEOUT_MS = 8_000;

export function sessionIdPattern(profileId: string): RegExp | null {
  switch (profileId.trim().toLowerCase()) {
    case "omp":
      return new RegExp(`\\"type\\":\\"session\\"[^\\n]*?\\"id\\":\\"(${UUID})\\"`, "gi");
    case "codex":
      return new RegExp(`\\"session_id\\":\\"(${UUID})\\"`, "gi");
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

export interface AgentSessionSummary {
  id: string;
  title: string;
  updatedAt: string;
}

function sessionRoot(home: string, profileId: string): string | null {
  const root = home.replace(/[\\/]+$/, "");
  switch (profileId.trim().toLowerCase()) {
    case "omp": return `${root}/.omp/agent/sessions`;
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
    const contentId = pattern ? [...transcript.matchAll(pattern)][0]?.[1] : undefined;
    const id = (pathId ?? contentId)?.toLowerCase();
    if (!id) continue;
    sessions.push({
      id,
      title: parseAgentSessionTitle(profileId, transcript) ?? `Session ${id.slice(0, 8)}`,
      updatedAt: Number.isFinite(modifiedSeconds)
        ? new Date(modifiedSeconds * 1_000).toISOString()
        : new Date(0).toISOString(),
    });
  }
  return sessions;
}

function sessionSegments(profileId: string): string | null {
  switch (profileId.trim().toLowerCase()) {
    case "omp": return ".omp/agent/sessions";
    case "codex": return ".codex/sessions";
    case "claude": return ".claude/projects";
    case "gemini": return ".gemini/tmp";
    default: return null;
  }
}
function hostHomeCwd(host: HostSession): string {
  return host.kind === "local" ? process.cwd() : "/";
}


async function runRecentSessionScanFromHome(
  host: HostSession,
  profileId: string,
  limit: number,
): Promise<string> {
  const segment = sessionSegments(profileId);
  if (!segment) return "";
  // Session files live under $HOME, so workspace validity is irrelevant.
  const cwd = hostHomeCwd(host);
  const root = `"$HOME/${segment}"`;
  const script = `root=${root}; if [ -d "$root" ]; then find "$root" -type f -name '*.jsonl' -printf '%T@\\t%p\\n' 2>/dev/null | sort -nr | head -n ${limit} | while IFS="$(printf '\\t')" read -r mtime file; do printf '\\036%s\\t%s\\n' "$mtime" "$file"; head -n 128 "$file"; printf '\\037\\n'; done; fi`;
  return (await host.run(cwd, "bash", ["-s"], {
    stdin: script,
    timeoutMs: AGENT_SESSION_SCAN_TIMEOUT_MS,
  })).stdout;
}

async function runRecentSessionScan(
  host: HostSession,
  root: string,
  limit: number,
): Promise<string> {
  const cwd = host.workspaceRoot || (host.kind === "local" ? process.cwd() : "/");
  if (host.kind === "local" && process.platform === "win32") {
    const rootArg = powershellQuote(root.replace(/\//g, "\\\\"));
    const command = [
      `$root=${rootArg}`,
      `if (Test-Path -LiteralPath $root) { Get-ChildItem -LiteralPath $root -Recurse -File -Filter *.jsonl -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First ${limit} | ForEach-Object { [Console]::Out.Write([char]30 + ([DateTimeOffset]$_.LastWriteTimeUtc).ToUnixTimeSeconds().ToString() + [char]9 + $_.FullName + [char]10); Get-Content -LiteralPath $_.FullName -TotalCount 128; [Console]::Out.Write([char]31 + [char]10) } }`,
    ].join("; ");
    return (await host.run(cwd, "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { timeoutMs: 8_000 })).stdout;
  }
  const rootArg = shellQuote(root);
  const script = `if [ -d ${rootArg} ]; then find ${rootArg} -type f -name '*.jsonl' -printf '%T@\\t%p\\n' 2>/dev/null | sort -nr | head -n ${limit} | while IFS="$(printf '\\t')" read -r mtime file; do printf '\\036%s\\t%s\\n' "$mtime" "$file"; head -n 128 "$file"; printf '\\037\\n'; done; fi`;
  if (host.kind === "wsl" || host.kind === "ssh") {
    return (await host.run(cwd, "bash", ["-s"], { stdin: script, timeoutMs: 8_000 })).stdout;
  }
  return (await host.run(cwd, "sh", ["-lc", script], { timeoutMs: 8_000 })).stdout;
}

export async function listAgentSessions(
  host: HostSession,
  profileId: string,
  limit = 12,
): Promise<AgentSessionSummary[]> {
  if (!sessionIdPattern(profileId)) return [];
  const count = Math.min(30, Math.max(1, limit));
  const text = host.kind === "wsl" || host.kind === "ssh"
    ? await runRecentSessionScanFromHome(host, profileId, count)
    : await (async () => {
        const home = await resolveHostHome(host);
        const root = sessionRoot(home, profileId);
        return root ? runRecentSessionScan(host, root, count) : "";
      })();
  return parseAgentSessionList(profileId, text);
}

async function runSessionPathScan(host: HostSession, root: string): Promise<string> {
  const cwd = hostHomeCwd(host);
  if (host.kind === "local" && process.platform === "win32") {
    const rootArg = powershellQuote(root.replace(/\//g, "\\\\"));
    const command = `$root=${rootArg}; if (Test-Path -LiteralPath $root) { Get-ChildItem -LiteralPath $root -Recurse -File -Filter *.jsonl -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName } }`;
    return (await host.run(cwd, "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { timeoutMs: 8_000 })).stdout;
  }
  const script = `if [ -d ${shellQuote(root)} ]; then find ${shellQuote(root)} -type f -name '*.jsonl' -print 2>/dev/null; fi`;
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
  for (const match of (await runSessionScan(host, root)).matchAll(pattern)) {
    if (match[1]) ids.add(match[1]);
  }
  return ids;
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
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    const current = await listAgentSessionIds(host, profileId);
    const created = claimCreatedAgentSession(current, before, claim);
    if (created) return created;
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
