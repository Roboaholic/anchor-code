import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import WebSocket from "ws";
import { RemoteRequestHandler } from "../../electron/application/remoteRequestHandler.js";
import { RelayConnector } from "../../electron/remote/relayConnector.js";
import { TerminalService, type TerminalServiceEvent } from "../../electron/services/terminalService.js";
import { LocalHostSession } from "../../electron/host/localHost.js";
import type { AnchorApplication } from "../../electron/application/anchorApplication.js";
import type { PtyHandle } from "../../electron/host/types.js";

const adb = process.env.ANDROID_ADB || "/home/zhenyu/env/android-sdk/platform-tools/adb";
const serial = process.env.ANDROID_EMULATOR_SERIAL || "emulator-5554";
const apk = process.env.ANCHOR_APK || "mobile/android/app/build/outputs/apk/debug/app-debug.apk";
const relayUrl = process.env.ANCHOR_RELAY_URL || "https://anchor-code-relay.anchor-code-mobile.workers.dev";
const packageName = "com.roboaholic.anchormobile";
const screenshot = process.env.ANCHOR_AGENT_SCREENSHOT || "/tmp/anchor-mobile-agent-emulator.png";
const workspaceRoot = "/home/zhenyu/workspace/anchor-code";
const realAgentCommand = process.env.ANCHOR_REAL_AGENT_COMMAND?.trim() || "";
const disableTerminalEvents = process.env.ANCHOR_DISABLE_TERMINAL_EVENTS === "1";

function adbRun(...args: string[]): string {
  return execFileSync(adb, ["-s", serial, ...args], { encoding: "utf8" }).trim();
}

async function waitFor<T>(label: string, read: () => T | Promise<T>, accept: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await read();
    if (accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}; last=${JSON.stringify(last!)}`);
}

class PipePty implements PtyHandle {
  readonly id = randomUUID();
  private readonly child: ChildProcessWithoutNullStreams;
  private dataListener: ((data: string) => void) | null = null;
  private exitListener: ((code: number) => void) | null = null;
  private pendingData: string[] = [];
  private pendingExit: number | null = null;

  constructor(command: string, args: string[], cwd: string) {
    this.child = spawn(command, args, { cwd, env: process.env, stdio: "pipe" });
    const data = (chunk: Buffer) => {
      const value = chunk.toString("utf8");
      if (this.dataListener) this.dataListener(value);
      else this.pendingData.push(value);
    };
    this.child.stdout.on("data", data);
    this.child.stderr.on("data", data);
    this.child.on("exit", (code) => {
      const value = code ?? 0;
      if (this.exitListener) this.exitListener(value);
      else this.pendingExit = value;
    });
  }

  write(data: string): void {
    // A real PTY converts Enter's carriage return into a line delimiter.
    this.child.stdin.write(data.replace(/\r/g, "\n"));
  }
  resize(): void {}
  onData(cb: (data: string) => void): void {
    this.dataListener = cb;
    for (const value of this.pendingData.splice(0)) cb(value);
  }
  onExit(cb: (code: number) => void): void {
    this.exitListener = cb;
    if (this.pendingExit !== null) cb(this.pendingExit);
  }
  kill(): void { this.child.kill(); }
}

function createFixtureApplication(): { application: AnchorApplication; terminal: TerminalService } {
  const pipeHost = {
    kind: "local",
    async openPty(cwd: string, _cols: number, _rows: number, opts?: { command?: string; args?: string[] }) {
      return new PipePty(opts?.command || "bash", opts?.args || [], cwd);
    },
  };
  const realHost = realAgentCommand ? new LocalHostSession("emulator-real-agent") : null;
  const terminal = new TerminalService(() => null, () => (realHost ?? pipeHost) as never);
  const listeners = new Set<(event: { type: "terminal"; event: TerminalServiceEvent }) => void>();
  terminal.subscribe((event) => {
    if (disableTerminalEvents) return;
    for (const listener of listeners) listener({ type: "terminal", event });
  });
  const status = {
    repoRoot: workspaceRoot,
    entries: [], modified: 0, added: 0, deleted: 0, untracked: 0,
    branch: "main", ahead: 0, behind: 0,
  };
  const application = {
    subscribe(listener: (event: { type: "terminal"; event: TerminalServiceEvent }) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    workspace: {
      current: () => ({ hostKind: "local", hostProfileId: "local", name: "anchor-code" }),
      root: () => workspaceRoot,
      active: () => ({ path: workspaceRoot, hostKind: "local", hostProfileId: "local", name: "anchor-code" }),
      hostInfo: () => ({ kind: "local" }),
      listApproved: async () => ({
        active: { path: workspaceRoot, hostProfileId: "local" },
        recent: [{ path: workspaceRoot, hostProfileId: "local", lastOpenedAt: new Date().toISOString(), name: "anchor-code", hostKind: "local", hostLabel: "Local" }],
      }),
      open: async () => ({ root: workspaceRoot, hostProfileId: "local" }),
    },
    review: {
      repos: async () => [{ root: workspaceRoot, name: "anchor-code" }],
      listFiles: async (path?: string | null) => ({ path: path || workspaceRoot, entries: [] }),
      readFile: async (path: string) => ({ path, content: "" }),
      fileIndex: async () => ({ root: workspaceRoot, files: [], truncated: false, source: "walk" }),
      search: async () => ({ query: "", truncated: false, hits: [] }),
      log: async () => [],
      status: async () => status,
      compare: async () => ({ base: "HEAD", head: "worktree", files: [] }),
      fileDiff: async (input: { path: string; status: string }) => ({ path: input.path, oldText: "", newText: "", status: input.status }),
    },
    comments: {
      list: async () => ({ sessions: [] }),
    },
    agent: {
      listProfiles: async () => ({
        profiles: [{ id: "emulator-agent", name: realAgentCommand ? `Real ${realAgentCommand}` : "Emulator Agent", command: realAgentCommand || "bash", detected: true, enabled: true }],
        defaultAgentId: "emulator-agent",
      }),
      launchOptions: async () => ({ profileId: "emulator-agent", supportsModel: false, supportsEffort: false, models: [] }),
      createSession: async (input: { prompt?: string; cols?: number; rows?: number }) => terminal.create({
        cwd: workspaceRoot,
        cols: input.cols,
        rows: input.rows,
        kind: "agent",
        command: realAgentCommand || "bash",
        args: realAgentCommand
          ? (input.prompt?.trim() ? [input.prompt.trim()] : [])
          : ["-c", "sleep 0.25; printf '\\033[2J\\033[HANCHOR_EMULATOR_AGENT_READY\\r\\n'; while IFS= read -r line; do printf 'ECHO:%s\\r\\n' \"$line\"; done"],
        title: input.prompt?.trim() || "Emulator Agent",
        agentId: "emulator-agent",
      }),
    },
    terminal: {
      list: () => terminal.list(),
      create: (input: { cols?: number; rows?: number }) => terminal.create({ ...input, cwd: workspaceRoot, kind: "shell" }),
      snapshot: (id: string) => {
        const state = terminal.snapshotState(id);
        if (!state) throw new Error(`Terminal not found: ${id}`);
        return { id, ...state };
      },
      write: (id: string, data: string) => terminal.write(id, data),
      resize: (id: string, cols: number, rows: number) => terminal.resize(id, cols, rows),
      remove: (id: string) => terminal.kill(id),
    },
  };
  return { application: application as unknown as AnchorApplication, terminal };
}

interface CdpMessage { id?: number; result?: { result?: { value?: unknown } }; error?: { message: string } }

async function connectCdp(): Promise<{ evaluate<T>(expression: string): Promise<T>; close(): void }> {
  const pid = await waitFor("Android WebView process", () => adbRun("shell", "pidof", packageName), Boolean, 10_000);
  const sockets = adbRun("shell", "cat", "/proc/net/unix");
  const socket = sockets.split("\n").map((line) => line.match(/@(webview_devtools_remote[^\s]*)/)?.[1]).find((name) => name?.includes(pid))
    || sockets.split("\n").map((line) => line.match(/@(webview_devtools_remote[^\s]*)/)?.[1]).find(Boolean);
  if (!socket) throw new Error("WebView DevTools socket was not exposed");
  adbRun("forward", "tcp:9222", `localabstract:${socket}`);
  const pages = await waitFor("WebView CDP page", async () => {
    const response = await fetch("http://127.0.0.1:9222/json");
    return await response.json() as Array<{ webSocketDebuggerUrl?: string }>;
  }, (value) => Boolean(value[0]?.webSocketDebuggerUrl), 10_000);
  const ws = new WebSocket(pages[0]!.webSocketDebuggerUrl!);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  let id = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as CdpMessage;
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result?.result?.value);
  });
  return {
    evaluate<T>(expression: string): Promise<T> {
      const requestId = ++id;
      return new Promise<T>((resolve, reject) => {
        pending.set(requestId, { resolve: (value) => resolve(value as T), reject });
        ws.send(JSON.stringify({ id: requestId, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
      });
    },
    close() { ws.close(); },
  };
}

test("APK creates an Agent and renders bidirectional terminal I/O through the real relay", async () => {
  expect(readFileSync(apk).length).toBeGreaterThan(100_000);
  const { application, terminal } = createFixtureApplication();
  const handler = new RemoteRequestHandler({ application, appVersion: "emulator-test" });
  const connector = new RelayConnector(handler);
  const config = {
    enabled: true,
    url: relayUrl,
    roomId: `emulator-${randomUUID()}`,
    hostPeerId: `pc-${randomUUID()}`,
    ticket: randomUUID() + randomUUID(),
    secret: randomUUID() + randomUUID(),
  };
  let cdp: Awaited<ReturnType<typeof connectCdp>> | null = null;
  try {
    connector.start(config);
    await waitFor("PC relay online", () => connector.info().state, (state) => state === "online", 20_000);
    const payload = JSON.stringify(connector.info().pairing);
    const encodedPayload = Buffer.from(payload, "utf8").toString("base64url");
    adbRun("install", "-r", apk);
    adbRun("shell", "pm", "clear", packageName);
    adbRun("logcat", "-c");
    adbRun("shell", "am", "start", "-n", `${packageName}/.MainActivity`, "--es", "anchor_pairing_payload_b64", encodedPayload);

    const peerId = await waitFor("mobile pairing request", () => connector.info().pendingDevices[0] || "", Boolean, 20_000);
    connector.approveDevice(peerId);
    cdp = await connectCdp();
    await waitFor("connected mobile UI", () => cdp!.evaluate<string>("document.body.innerText"), (body) => body.includes("Review") && body.includes("Agent"), 30_000);
    await cdp.evaluate(`(() => { const button = [...document.querySelectorAll('nav button')].find((node) => node.textContent?.includes('Agent')); button?.click(); return Boolean(button); })()`);
    await waitFor("Agent launch button", () => cdp!.evaluate<string>("document.body.innerText"), (body) => body.includes("启动 Agent 会话"), 10_000);
    if (realAgentCommand) {
      await cdp.evaluate(`(() => {
        const textarea = document.querySelector('.agent-launch textarea');
        if (!(textarea instanceof HTMLTextAreaElement)) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(textarea, 'Reply exactly ANCHOR_REAL_AGENT_RESPONSE and do not modify files.');
        textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
        return true;
      })()`);
    }
    const launched = await cdp.evaluate<boolean>(`(() => { const button = [...document.querySelectorAll('button')].find((node) => node.textContent?.includes('启动 Agent 会话')); button?.click(); return Boolean(button); })()`);
    expect(launched).toBe(true);
    if (realAgentCommand) {
      const info = await waitFor("real PC terminal", () => terminal.list().find((item) => item.kind === "agent") || null, Boolean, 10_000);
      const raw = await waitFor("real PC Agent output", () => terminal.snapshot(info!.id) || "", (value) => value.length > 20, 30_000);
      const rendered = await waitFor("real Agent xterm content", () => cdp!.evaluate<string>("document.querySelector('.xterm-rows')?.textContent || document.querySelector('.terminal-plain-fallback')?.textContent || ''"), (text) => text.trim().length > 0, 30_000).catch(async (error) => {
        const state = await cdp!.evaluate(`JSON.stringify({ body: document.body.innerText, xterm: Boolean(document.querySelector('.xterm')), rows: document.querySelector('.xterm-rows')?.textContent || '', fallback: document.querySelector('.terminal-plain-fallback')?.textContent || '' })`);
        throw new Error(`${error instanceof Error ? error.message : error}; pcRawChars=${raw.length}; apkState=${state}`);
      });
      expect(raw.length).toBeGreaterThan(20);
      expect(rendered.trim().length).toBeGreaterThan(0);
      writeFileSync(screenshot, execFileSync(adb, ["-s", serial, "exec-out", "screencap", "-p"]));
      console.info(`ANCHOR_REAL_AGENT_EMULATOR_RESULT=PASS command=${realAgentCommand} pcRawChars=${raw.length} renderedChars=${rendered.length}`);
      return;
    }
    await waitFor("Agent READY output", () => cdp!.evaluate<string>("document.querySelector('.xterm-rows')?.textContent || document.querySelector('.terminal-plain-fallback')?.textContent || ''"), (text) => text.includes("ANCHOR_EMULATOR_AGENT_READY"), 30_000);

    const typed = await cdp.evaluate<boolean>(`(() => {
      const textarea = document.querySelector('.agent-composer textarea');
      if (!(textarea instanceof HTMLTextAreaElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, 'mobile-ping');
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'mobile-ping' }));
      return true;
    })()`);
    expect(typed).toBe(true);
    await waitFor("enabled Agent send button", () => cdp!.evaluate<boolean>("!document.querySelector('.agent-composer button')?.disabled"), Boolean, 5_000);
    await cdp.evaluate(`document.querySelector('.agent-composer button')?.click()`);
    const output = await waitFor("Agent input echo", () => cdp!.evaluate<string>("document.querySelector('.xterm-rows')?.textContent || document.querySelector('.terminal-plain-fallback')?.textContent || ''"), (text) => text.includes("ECHO:mobile-ping"), 30_000);
    expect(output).toContain("ANCHOR_EMULATOR_AGENT_READY");
    expect(output).toContain("ECHO:mobile-ping");

    writeFileSync(screenshot, execFileSync(adb, ["-s", serial, "exec-out", "screencap", "-p"]));
    console.info(`ANCHOR_AGENT_EMULATOR_RESULT=PASS peer=${peerId} screenshot=${screenshot}`);
  } finally {
    cdp?.close();
    connector.stop();
    handler.dispose();
    terminal.disposeAll();
    try { adbRun("forward", "--remove", "tcp:9222"); } catch {}
  }
}, 120_000);
