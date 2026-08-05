import type { BrowserWindow } from "electron";
import type { HostSession, PtyHandle } from "../host/types.js";
import { hostBasename } from "../host/paths.js";
import { shellDisplayName } from "../host/localPty.js";

export type TerminalSessionKind = "shell" | "agent";

export type TerminalTitleSource = "default" | "user" | "inferred";

export interface TerminalTabInfo {
  id: string;
  title: string;
  cwd: string;
  status: "running" | "exited";
  kind: TerminalSessionKind;
  agentId?: string;
  agentSessionId?: string;
  /** How the title was set — user renames win over auto-inferred topics. */
  titleSource?: TerminalTitleSource;
}

export interface TerminalCreateOptions {
  cwd: string;
  cols?: number;
  rows?: number;
  kind?: TerminalSessionKind;
  command?: string;
  args?: string[];
  title?: string;
  agentId?: string;
  agentSessionId?: string;
}

export type TerminalServiceEvent =
  | { type: "created"; info: TerminalTabInfo }
  | { type: "updated"; info: TerminalTabInfo }
  | { type: "data"; id: string; data: string; seq: number }
  | {
      type: "exit";
      id: string;
      exitCode: number;
      kind: TerminalSessionKind;
    }
  | { type: "removed"; id: string; kind: TerminalSessionKind };

interface TabInternal {
  info: TerminalTabInfo;
  handle: PtyHandle;
  /** Recent raw PTY output for reconnecting remote xterm clients. */
  outBuf: BoundedTextBuffer;
  /** Monotonic per-session output cursor used to merge snapshot + live data. */
  outputSeq: number;
}

const REMOTE_REPLAY_MAX_CHARS = 512 * 1024;
const TERMINAL_EVENT_MAX_CHARS = 64 * 1024;

/** Chunked ring buffer avoids repeatedly copying a 512 KiB string per PTY write. */
class BoundedTextBuffer {
  private chunks: string[] = [];
  private length = 0;

  constructor(private readonly maxChars: number) {}

  append(value: string): void {
    if (!value) return;
    this.chunks.push(value);
    this.length += value.length;
    while (this.length > this.maxChars && this.chunks.length > 0) {
      const overflow = this.length - this.maxChars;
      const first = this.chunks[0]!;
      if (first.length <= overflow) {
        this.chunks.shift();
        this.length -= first.length;
      } else {
        this.chunks[0] = first.slice(overflow);
        this.length -= overflow;
      }
    }
  }

  toString(): string {
    return this.chunks.join("");
  }
}

/**
 * Multi-tab terminal manager. Spawns PTYs through the active HostSession.
 * Shell and agent sessions share the same pool; kind is metadata only.
 */
export class TerminalService {
  private tabs = new Map<string, TabInternal>();
  private getWindow: () => BrowserWindow | null;
  private getHost: () => HostSession;
  private counter = 0;
  private subscribers = new Set<(event: TerminalServiceEvent) => void>();

  constructor(
    getWindow: () => BrowserWindow | null,
    getHost: () => HostSession,
  ) {
    this.getWindow = getWindow;
    this.getHost = getHost;
  }

  private send(channel: string, payload: unknown) {
    const win = this.getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }

  subscribe(listener: (event: TerminalServiceEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  private emit(event: TerminalServiceEvent): void {
    for (const listener of this.subscribers) {
      try {
        listener(event);
      } catch {
        // A remote observer must never disrupt the PTY callback.
      }
    }
  }

  private publishInfo(type: "created" | "updated", info: TerminalTabInfo): void {
    this.send(`terminal:${type}`, { info });
    this.emit({ type, info });
  }

  list(): TerminalTabInfo[] {
    return [...this.tabs.values()].map((t) => t.info);
  }

  snapshot(id: string): string | null {
    const tab = this.tabs.get(id);
    if (!tab) return null;
    return tab.outBuf.toString();
  }

  snapshotState(id: string): { data: string; seq: number } | null {
    const tab = this.tabs.get(id);
    if (!tab) return null;
    return { data: tab.outBuf.toString(), seq: tab.outputSeq };
  }

  async create(opts: TerminalCreateOptions): Promise<TerminalTabInfo> {
    const host = this.getHost();
    const cols = opts.cols ?? 80;
    const rows = opts.rows ?? 24;
    const kind: TerminalSessionKind = opts.kind ?? "shell";
    const spawnOpts =
      opts.command && opts.command.trim()
        ? { command: opts.command.trim(), args: opts.args ?? [] }
        : undefined;

    const handle = await host.openPty(opts.cwd, cols, rows, spawnOpts);
    this.counter += 1;

    let title = opts.title?.trim();
    if (!title) {
      if (kind === "agent") {
        // Stable label: CLI display name + local time (no PTY scraping).
        const name =
          opts.agentId?.trim() ||
          (opts.command ? shellDisplayName(opts.command) : "Agent");
        title = formatAgentSessionTitle(name);
      } else {
        // Shell sessions: follow cwd directory name (not "1: wsl").
        title = titleFromCwd(host.kind, opts.cwd);
      }
    }

    const info: TerminalTabInfo = {
      id: handle.id,
      title,
      cwd: opts.cwd,
      status: "running",
      kind,
      agentId: opts.agentId,
      agentSessionId: opts.agentSessionId,
      titleSource: "default",
    };
    this.tabs.set(handle.id, {
      info,
      handle,
      outBuf: new BoundedTextBuffer(REMOTE_REPLAY_MAX_CHARS),
      outputSeq: 0,
    });

    handle.onData((data) => {
      const current = this.tabs.get(handle.id);
      if (!current) return;
      current.outBuf.append(data);
      for (let offset = 0; offset < data.length; offset += TERMINAL_EVENT_MAX_CHARS) {
        const chunk = data.slice(offset, offset + TERMINAL_EVENT_MAX_CHARS);
        current.outputSeq += 1;
        const seq = current.outputSeq;
        this.send("terminal:data", { id: handle.id, data: chunk, seq });
        this.emit({ type: "data", id: handle.id, data: chunk, seq });
      }
      // Intentionally no PTY topic inference for agents — TUI noise is unreliable.
    });
    handle.onExit((exitCode) => {
      const tab = this.tabs.get(handle.id);
      if (tab) {
        tab.info = { ...tab.info, status: "exited" };
      }
      this.send("terminal:exit", {
        id: handle.id,
        exitCode,
        kind: tab?.info.kind ?? info.kind,
      });
      this.emit({
        type: "exit",
        id: handle.id,
        exitCode,
        kind: tab?.info.kind ?? info.kind,
      });
    });

    this.publishInfo("created", info);
    return info;
  }

  setAgentSessionId(id: string, agentSessionId: string): TerminalTabInfo | null {
    const tab = this.tabs.get(id);
    const next = agentSessionId.trim();
    if (!tab || !next) return tab?.info ?? null;
    tab.info = { ...tab.info, agentSessionId: next };
    this.publishInfo("updated", tab.info);
    return tab.info;
  }

  setAgentTitle(id: string, title: string): TerminalTabInfo | null {
    const tab = this.tabs.get(id);
    const next = title.trim();
    if (!tab || !next || tab.info.titleSource === "user") return tab?.info ?? null;
    tab.info = { ...tab.info, title: next, titleSource: "inferred" };
    this.publishInfo("updated", tab.info);
    return tab.info;
  }

  rename(id: string, title: string): TerminalTabInfo | null {
    const tab = this.tabs.get(id);
    if (!tab) return null;
    const next = title.trim() || tab.info.title;
    tab.info = { ...tab.info, title: next, titleSource: "user" };
    this.publishInfo("updated", tab.info);
    return tab.info;
  }

  /**
   * Update title from terminal OSC (shell cwd only).
   * Agent titles come from user prompts in PTY output — OSC is usually user@host.
   */
  applyDynamicTitle(id: string, rawTitle: string): TerminalTabInfo | null {
    const tab = this.tabs.get(id);
    if (!tab) return null;
    if (tab.info.titleSource === "user") return tab.info;
    // Never use window/OSC title for agents (often "miles@host:~/…").
    if (tab.info.kind === "agent") return tab.info;

    const next = normalizeDynamicTitle(rawTitle, tab.info.title);
    if (!next || next === tab.info.title) return tab.info;
    tab.info = { ...tab.info, title: next, titleSource: "inferred" };
    this.publishInfo("updated", tab.info);
    return tab.info;
  }
  /**
   * Kept for API compatibility. Agent titles are name+time (or user rename);
   * automatic prompt scraping is disabled.
   */
  applyAgentTopicFromInput(
    id: string,
    _line: string,
  ): TerminalTabInfo | null {
    const tab = this.tabs.get(id);
    return tab?.info ?? null;
  }

  write(id: string, data: string): void {
    const tab = this.tabs.get(id);
    if (!tab || tab.info.status !== "running") return;
    tab.handle.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const tab = this.tabs.get(id);
    if (!tab || tab.info.status !== "running") return;
    tab.handle.resize(cols, rows);
  }

  kill(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const kind = tab.info.kind;
    try {
      tab.handle.kill();
    } catch {
      // ignore
    }
    this.tabs.delete(id);
    this.send("terminal:removed", { id, kind });
    this.emit({ type: "removed", id, kind });
  }

  disposeAll(): void {
    for (const id of [...this.tabs.keys()]) {
      this.kill(id);
    }
    this.counter = 0;
  }
}

/** `Codex · 18:32` — agent CLI name + local HH:mm. */
export function formatAgentSessionTitle(
  name: string,
  at: Date = new Date(),
): string {
  const label = name.trim() || "Agent";
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");
  return `${label} · ${hh}:${mm}`;
}

export function titleFromCwd(
  kind: HostSession["kind"],
  cwd: string,
): string {
  const cleaned = (cwd || "").replace(/[\\/]+$/, "");
  if (!cleaned || cleaned === "/" || cleaned === ".") return cleaned || "/";
  const base = hostBasename(kind, cleaned);
  // Windows drive root "C:\" → "C:"
  if (!base || base === cleaned) {
    const parts = cleaned.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts[parts.length - 1] || base || cleaned;
  }
  return base;
}

/** Pull directory name from OSC titles like `user@host:~/proj` or full paths. */
export function normalizeDynamicTitle(
  raw: string,
  fallback: string,
): string {
  let s = raw.trim();
  if (!s) return fallback;
  // Strip common `user@host:` / `user@host ` prefixes
  s = s.replace(/^[^:]{1,64}@[^:]{1,64}:\s*/, "");
  s = s.replace(/^[^@\s]{1,64}@[^:\s]{1,64}\s+/, "");
  // Drop trailing shell markers
  s = s.replace(/[\s|·•].*$/, "").trim();
  if (!s) return fallback;
  // Expand ~ only for display basename
  if (s === "~") return "~";
  if (s.startsWith("~/")) s = s.slice(2);
  s = s.replace(/[\\/]+$/, "");
  const parts = s.replace(/\\/g, "/").split("/").filter(Boolean);
  const base = parts[parts.length - 1];
  return base || fallback;
}

const AGENT_TITLE_NOISE =
  /^(codex|claude|claude code|aider|goose|gemini|gemini cli|cursor agent|cursor-agent|bash|zsh|sh|fish|shell|wsl|cmd|powershell|pwsh|terminal|agent|openai codex)$/i;

/** Known short usernames / host labels we never want as topics. */
const JUNK_SINGLE_TOKENS = new Set(
  [
    "miles",
    "root",
    "admin",
    "user",
    "ubuntu",
    "linux",
    "wsl",
    "localhost",
    "home",
    "tmp",
    "temp",
    "working",
    "thinking",
    "loading",
    "ready",
  ].map((s) => s.toLowerCase()),
);

/**
 * Aggressive ANSI / control strip for TUI scrapes.
 * Incomplete CSI (e.g. "4;0m" after ESC lost) must not become titles.
 */
export function stripAnsi(s: string): string {
  let out = s
    // OSC … BEL / ST
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
    // Full CSI sequences
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // C1 CSI (0x9b)
    .replace(/\u009b[0-9;?]*[ -/]*[@-~]/g, "")
    // Other ESC + one byte (or longer private)
    .replace(/\u001b[PX^_].*?(?:\u001b\\|\u0007|$)/g, "")
    .replace(/\u001b./g, "")
    // Orphan CSI tails after ESC was stripped: "4;0m", "0m", "38;5;12m"
    .replace(/(?:^|[^A-Za-z0-9_])\d{1,3}(?:;\d{1,3})*[A-Za-z](?=[^A-Za-z0-9_]|$)/g, " ")
    .replace(/\d{1,3}(?:;\d{1,3})*m/g, "")
    // Bare control chars
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return out;
}

/** True if string still looks like escape debris. */
export function looksLikeAnsiDebris(s: string): boolean {
  const t = s.trim();
  if (!t) return true;
  if (/[\u001b\u009b]/.test(t)) return true;
  // "4;0m>7u", "0m", "38;2;255m"
  if (/\d;\d/.test(t) && /[A-Za-z]/.test(t) && t.length <= 24) return true;
  if (/^\d{1,3}(?:;\d{1,3})*[A-Za-z]/.test(t)) return true;
  if (/m[>›❯]/.test(t) || /[>›❯]\d/.test(t)) return true;
  // Mostly punctuation / digits
  const letters = t.replace(/[^\p{L}\p{N}\s@._-]/gu, "");
  if (letters.length < Math.min(2, t.length) && /[;<>]/.test(t)) return true;
  return false;
}

/** Reject path / host / username / spinner chrome mistaken for chat topics. */
export function isJunkAgentTopic(s: string): boolean {
  const t = s.trim();
  if (!t) return true;
  if (looksLikeAnsiDebris(t)) return true;
  if (AGENT_TITLE_NOISE.test(t)) return true;
  // Pure numbers / counters (tab index "1", "2")
  if (/^\d{1,3}$/.test(t)) return true;
  // user@host or user@host:path
  if (/^[\w.-]+@[\w.-]+/.test(t)) return true;
  // Absolute / home paths (and bare ~ segments)
  if (/^~(?:\/|$)/.test(t) || /^\/(?:home|Users|users)\b/i.test(t)) return true;
  if (/^[A-Za-z]:[\\/]/.test(t) || /^\\\\/.test(t)) return true;
  if (/^\/[\w./-]+$/.test(t)) return true;
  // directory: ~/… chrome leaks
  if (/^(directory|model|cwd|workdir|openai|working|thinking)\b/i.test(t)) {
    return true;
  }
  // Version / model crumbs
  if (/^v?\d+\.\d+/.test(t)) return true;
  if (/^gpt-[\w.-]+/i.test(t)) return true;
  // Known junk single tokens only (not every short English word — "what" is ok)
  if (
    /^[A-Za-z][A-Za-z0-9._-]*$/.test(t) &&
    JUNK_SINGLE_TOKENS.has(t.toLowerCase())
  ) {
    return true;
  }
  // Extremely short pure-ascii with no letters of a message (e.g. ">>")
  if (/^[^A-Za-z\u3400-\u9fff]+$/.test(t)) return true;
  return false;
}

/**
 * Find the first real user prompt line in agent TUI output.
 * Prefer Codex/Claude markers `›` / `❯`.
 */
export function extractFirstAgentUserPrompt(raw: string): string | null {
  const plain = stripAnsi(raw)
    .replace(/\u009b/g, "\u001b[")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  // Codex › (U+203A), ❯, and fullwidth variants. Avoid bare ASCII ">" alone —
  // it collides with residual CSI like "0m>text".
  const strong =
    /(?:^|\n)[ \t]*(?:[›❯〉]|>>)[ \t\u200b\u200c\u200d\ufeff]*([^\n]+)/g;
  let m: RegExpExecArray | null;
  const candidates: string[] = [];
  while ((m = strong.exec(plain))) {
    let line = (m[1] ?? "").trim();
    // Clean residual CSI tails glued to start: "0mwhat" / "4;0mwhat"
    line = line.replace(/^(?:\d{1,3}(?:;\d{1,3})*[A-Za-z])+/, "").trim();
    if (!line) continue;
    if (
      /^(tip:|model:|directory:|openai codex|context\b|\/model\b|gpt-|working\b|esc to)/i.test(
        line,
      )
    ) {
      continue;
    }
    if (isJunkAgentTopic(line)) continue;
    candidates.push(line);
  }
  // Prefer CJK / multi-word / longer tokens
  for (const line of candidates) {
    if (/[\u3400-\u9fff]/.test(line) || line.split(/\s+/).length >= 2) {
      return line;
    }
  }
  // Single English word prompts ("what", "hi") allowed if not junk-listed
  for (const line of candidates) {
    if (line.length >= 2 && !isJunkAgentTopic(line)) return line;
  }
  return null;
}

/**
 * Local (no-LLM) topic compression for session rail labels.
 * Short prompts stay near-verbatim; long text → first clause + soft cap.
 */
export function summarizeTopicLocal(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;

  // Drop fenced code blocks (keep prose around them).
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/`([^`]+)`/g, "$1");

  // @/path/to/file or @file → @basename
  s = s.replace(/@((?:[A-Za-z]:)?[^\s@]+)/g, (_m, p: string) => {
    const base = p.replace(/\\/g, "/").split("/").filter(Boolean).pop();
    return base ? `@${base}` : "";
  });

  // Collapse whitespace / newlines to single spaces for rail.
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return null;

  // Polite / filler prefixes (EN + ZH) — only at start.
  const fillers = [
    /^(请帮我|麻烦你?|麻烦|请你?|帮我|帮忙|劳驾|可否|能否|我想要?|我希望|需要你?|麻烦帮我)\s*/u,
    /^(please\s+)?(can|could|would)\s+you\s+(please\s+)?/i,
    /^(please|pls|plz)\s+/i,
    /^(i\s+)?(want|need|would\s+like)\s+to\s+/i,
    /^(help\s+me\s+(to\s+)?)/i,
  ];
  for (const re of fillers) {
    s = s.replace(re, "");
  }
  s = s.trim();
  if (!s) return null;

  // First sentence / clause: 。！？… or ，, or .!?
  const clause = s.match(
    /^(.+?(?:[。！？…]|，(?=.+)|,(?=\s*\S)|[.!?](?=\s|$)))/u,
  );
  if (clause?.[1] && clause[1].length >= 2 && clause[1].length < s.length) {
    s = clause[1].replace(/[。！？.!?…，,]+$/u, "").trim();
  }

  const chars = [...s];
  const cjk = chars.filter((c) =>
    /[\u3400-\u9fff\uf900-\ufaff]/.test(c),
  ).length;
  const max = cjk >= chars.length * 0.4 ? 22 : 40;
  if (chars.length > max) {
    s = `${chars.slice(0, max - 1).join("")}…`;
  }

  return s || null;
}

/**
 * Turn first user prompt into a short conversation topic (local rules only).
 */
export function normalizeAgentTopic(
  raw: string,
  tab: Pick<TerminalTabInfo, "title" | "agentId">,
): string | null {
  let s = raw.trim().replace(/\s+/g, " ");
  if (!s) return null;
  // Strip prompt decorations
  s = s.replace(/^[›❯>$#%•·]\s*/, "");
  // user@host:…  / miles@pc:…
  s = s.replace(/^[\w.-]+@[\w.-]+:\s*/, "");
  s = s.replace(/^[\w.-]+@[\w.-]+\s+/, "");
  if (s.length < 1) return null;
  if (s.length < 2 && /^[\x00-\x7f]$/.test(s)) return null;
  if (isJunkAgentTopic(s)) return null;
  if (tab.agentId && s.toLowerCase() === tab.agentId.toLowerCase()) return null;
  if (
    tab.title &&
    s.toLowerCase() === tab.title.toLowerCase() &&
    AGENT_TITLE_NOISE.test(tab.title)
  ) {
    return null;
  }

  const summarized = summarizeTopicLocal(s);
  if (!summarized || isJunkAgentTopic(summarized)) return null;
  return summarized;
}

// Re-export for tests that still import ensureSpawnHelperExecutable from here.
export { ensureSpawnHelperExecutable } from "../host/localPty.js";
