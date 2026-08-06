import type { HostSession } from "../host/types.js";
import { resolveHostHome } from "./skillInstall.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export const AGENT_SESSION_CAPTURE_TIMEOUT_MS = 5 * 60_000;

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

async function runSessionScan(host: HostSession, root: string, sessionId?: string): Promise<string> {
  const cwd = host.workspaceRoot || (host.kind === "local" ? process.cwd() : "/");
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
  const cwd = host.workspaceRoot || (host.kind === "local" ? process.cwd() : "/");
  const script = "import{Database}from'bun:sqlite';import{homedir}from'node:os';import{join}from'node:path';try{const d=new Database(join(homedir(),'.grok','grok.db'),{readonly:true});console.log(d.query('select id from sessions').all().map(x=>x.id).join('\\n'))}catch{}";
  const result = await host.run(cwd, "bun", ["-e", script], { timeoutMs: 8_000 });
  return new Set(result.stdout.split(/\r?\n/).map((id) => id.trim()).filter(Boolean));
}

export async function listAgentSessionIds(host: HostSession, profileId: string): Promise<Set<string>> {
  if (profileId.trim().toLowerCase() === "grok") return grokSessionIds(host);
  const pattern = sessionIdPattern(profileId);
  if (!pattern) return new Set();
  const home = await resolveHostHome(host);
  const root = sessionRoot(home, profileId);
  if (!root) return new Set();
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
    const cwd = host.workspaceRoot || (host.kind === "local" ? process.cwd() : "/");
    const script = `import{Database}from'bun:sqlite';import{homedir}from'node:os';import{join}from'node:path';try{const d=new Database(join(homedir(),'.grok','grok.db'),{readonly:true});const r=d.query('select title from sessions where id = ?').get(${JSON.stringify(sessionId)});if(r?.title)console.log(r.title)}catch{}`;
    return cleanTitle((await host.run(cwd, "bun", ["-e", script], { timeoutMs: 8_000 })).stdout);
  }
  const home = await resolveHostHome(host);
  const root = sessionRoot(home, profileId);
  if (!root) return null;
  return parseAgentSessionTitle(profileId, await runSessionScan(host, root, sessionId));
}
