import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserWindow } from "electron";
import type { IPty } from "node-pty";

export interface TerminalTabInfo {
  id: string;
  title: string;
  cwd: string;
  status: "running" | "exited";
}

interface TabInternal {
  info: TerminalTabInfo;
  pty: IPty;
}

/**
 * Multi-tab local PTY manager (Slice 5).
 */
export class TerminalService {
  private tabs = new Map<string, TabInternal>();
  private getWindow: () => BrowserWindow | null;
  private counter = 0;

  constructor(getWindow: () => BrowserWindow | null) {
    this.getWindow = getWindow;
    ensureSpawnHelperExecutable();
  }

  private send(channel: string, payload: unknown) {
    const win = this.getWindow();
    win?.webContents.send(channel, payload);
  }

  list(): TerminalTabInfo[] {
    return [...this.tabs.values()].map((t) => t.info);
  }

  async create(cwd: string, cols = 80, rows = 24): Promise<TerminalTabInfo> {
    ensureSpawnHelperExecutable();

    let ptyModule: typeof import("node-pty");
    try {
      ptyModule = await import("node-pty");
    } catch (err) {
      throw new Error(
        `node-pty is not available: ${err instanceof Error ? err.message : String(err)}. Run: npm run rebuild:native`,
      );
    }

    const shell = resolveShell();
    const safeCwd = resolveCwd(cwd);
    const env = buildPtyEnv();
    const id = randomUUID();
    this.counter += 1;
    const title = `${this.counter}: ${shellName(shell)}`;

    let pty: IPty;
    try {
      pty = ptyModule.spawn(shell, shellArgs(shell), {
        name: "xterm-256color",
        cols: Math.max(cols, 20),
        rows: Math.max(rows, 5),
        cwd: safeCwd,
        env,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Common on macOS when spawn-helper lost +x after npm install.
      if (/posix_spawnp/i.test(msg)) {
        ensureSpawnHelperExecutable();
        try {
          pty = ptyModule.spawn(shell, shellArgs(shell), {
            name: "xterm-256color",
            cols: Math.max(cols, 20),
            rows: Math.max(rows, 5),
            cwd: safeCwd,
            env,
          });
        } catch (err2) {
          throw new Error(
            `Failed to start shell (${shell}) in ${safeCwd}: ${
              err2 instanceof Error ? err2.message : String(err2)
            }. If this persists: npm run rebuild:native && npm run ensure:pty`,
          );
        }
      } else {
        throw new Error(
          `Failed to start shell (${shell}) in ${safeCwd}: ${msg}`,
        );
      }
    }

    const info: TerminalTabInfo = {
      id,
      title,
      cwd: safeCwd,
      status: "running",
    };
    this.tabs.set(id, { info, pty });

    pty.onData((data) => {
      this.send("terminal:data", { id, data });
    });
    pty.onExit(({ exitCode }) => {
      const tab = this.tabs.get(id);
      if (tab) {
        tab.info = { ...tab.info, status: "exited" };
      }
      this.send("terminal:exit", { id, exitCode });
    });

    return info;
  }

  write(id: string, data: string): void {
    const tab = this.tabs.get(id);
    if (!tab || tab.info.status !== "running") return;
    tab.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const tab = this.tabs.get(id);
    if (!tab || tab.info.status !== "running") return;
    try {
      tab.pty.resize(Math.max(cols, 2), Math.max(rows, 1));
    } catch {
      // ignore invalid sizes
    }
  }

  kill(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    try {
      tab.pty.kill();
    } catch {
      // ignore
    }
    this.tabs.delete(id);
  }

  disposeAll(): void {
    for (const id of [...this.tabs.keys()]) {
      this.kill(id);
    }
    this.counter = 0;
  }
}

function shellName(shell: string): string {
  return shell.split(/[/\\]/).pop() ?? "shell";
}

function shellArgs(shell: string): string[] {
  const base = shellName(shell).toLowerCase();
  // Login shell so PATH / rbenv / nvm match Terminal.app habits.
  if (base === "zsh" || base === "bash") return ["-l"];
  return [];
}

function resolveShell(): string {
  const candidates = [
    process.env.SHELL,
    "/bin/zsh",
    "/bin/bash",
    "/usr/bin/zsh",
    "/usr/bin/bash",
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {
      // continue
    }
  }
  return "/bin/zsh";
}

function resolveCwd(cwd: string): string {
  try {
    if (cwd && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) {
      return cwd;
    }
  } catch {
    // fall through
  }
  return process.env.HOME || process.cwd();
}

function buildPtyEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  // Electron/Chromium vars can confuse some shells; keep a clean TERM.
  env.TERM = env.TERM || "xterm-256color";
  env.COLORTERM = env.COLORTERM || "truecolor";
  // Prefer user PATH over Electron's limited one when available.
  if (!env.PATH || env.PATH.length < 8) {
    env.PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  }
  return env;
}

/**
 * Fix non-executable spawn-helper from npm prebuilds (macOS posix_spawnp failed).
 */
export function ensureSpawnHelperExecutable(): void {
  try {
    const candidates = collectSpawnHelpers();
    for (const helper of candidates) {
      try {
        const st = fs.statSync(helper);
        if ((st.mode & 0o111) === 0) {
          fs.chmodSync(helper, st.mode | 0o755);
        }
      } catch {
        // ignore individual failures
      }
    }
  } catch {
    // non-fatal
  }
}

function collectSpawnHelpers(): string[] {
  const out: string[] = [];
  // node-pty package root next to our app
  const roots = [
    path.join(process.cwd(), "node_modules", "node-pty"),
    // when packaged / different cwd
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "node_modules",
      "node-pty",
    ),
  ];

  for (const root of roots) {
    for (const sub of ["prebuilds", "build"]) {
      const dir = path.join(root, sub);
      walkSpawnHelpers(dir, out);
    }
  }
  return [...new Set(out)];
}

function walkSpawnHelpers(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const p = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkSpawnHelpers(p, out);
    else if (name === "spawn-helper") out.push(p);
  }
}
