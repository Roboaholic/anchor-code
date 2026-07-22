import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IPty } from "node-pty";
import type { PtyHandle } from "./types.js";
import { HostError } from "./types.js";

/**
 * Spawn a local interactive shell via node-pty and wrap as PtyHandle.
 */
export async function spawnLocalPty(
  cwd: string,
  cols: number,
  rows: number,
  opts?: { shell?: string; args?: string[]; env?: Record<string, string> },
): Promise<{ handle: PtyHandle; shell: string; cwd: string }> {
  ensureSpawnHelperExecutable();

  let ptyModule: typeof import("node-pty");
  try {
    ptyModule = await import("node-pty");
  } catch (err) {
    throw new HostError(
      "failed",
      `node-pty is not available: ${err instanceof Error ? err.message : String(err)}. Run: npm run rebuild:native`,
    );
  }

  const shell = opts?.shell ?? resolveShell();
  const args = opts?.args ?? shellArgs(shell);
  const safeCwd = resolveCwd(cwd);
  const env = opts?.env ?? buildPtyEnv();
  const id = cryptoRandomId();

  let pty: IPty;
  try {
    pty = ptyModule.spawn(shell, args, {
      name: "xterm-256color",
      cols: Math.max(cols, 20),
      rows: Math.max(rows, 5),
      cwd: safeCwd,
      env,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/posix_spawnp/i.test(msg)) {
      ensureSpawnHelperExecutable();
      try {
        pty = ptyModule.spawn(shell, args, {
          name: "xterm-256color",
          cols: Math.max(cols, 20),
          rows: Math.max(rows, 5),
          cwd: safeCwd,
          env,
        });
      } catch (err2) {
        throw new HostError(
          "failed",
          `Failed to start shell (${shell}) in ${safeCwd}: ${
            err2 instanceof Error ? err2.message : String(err2)
          }. If this persists: npm run rebuild:native && npm run ensure:pty`,
        );
      }
    } else {
      throw new HostError(
        "failed",
        `Failed to start shell (${shell}) in ${safeCwd}: ${msg}`,
      );
    }
  }

  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(code: number) => void>();
  let alive = true;

  pty.onData((data) => {
    for (const cb of dataListeners) cb(data);
  });
  pty.onExit(({ exitCode }) => {
    alive = false;
    for (const cb of exitListeners) cb(exitCode);
  });

  const handle: PtyHandle = {
    id,
    write(data: string) {
      if (!alive) return;
      pty.write(data);
    },
    resize(c: number, r: number) {
      if (!alive) return;
      try {
        pty.resize(Math.max(c, 2), Math.max(r, 1));
      } catch {
        // ignore invalid sizes
      }
    },
    onData(cb) {
      dataListeners.add(cb);
    },
    onExit(cb) {
      exitListeners.add(cb);
    },
    kill() {
      if (!alive) return;
      alive = false;
      try {
        pty.kill();
      } catch {
        // ignore
      }
    },
  };

  return { handle, shell, cwd: safeCwd };
}

export function shellDisplayName(shell: string): string {
  return shell.split(/[/\\]/).pop() ?? "shell";
}

function cryptoRandomId(): string {
  return `pty-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function shellArgs(shell: string): string[] {
  const base = shellDisplayName(shell).toLowerCase();
  if (base === "zsh" || base === "bash") return ["-l"];
  return [];
}

function resolveShell(): string {
  if (process.platform === "win32") {
    const comspec = process.env.COMSPEC;
    if (comspec && fs.existsSync(comspec)) return comspec;
    const pwsh = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    if (fs.existsSync(pwsh)) return pwsh;
    return "cmd.exe";
  }

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
  return process.env.HOME || process.env.USERPROFILE || process.cwd();
}

function buildPtyEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  env.TERM = env.TERM || "xterm-256color";
  env.COLORTERM = env.COLORTERM || "truecolor";
  if (!env.PATH || env.PATH.length < 8) {
    env.PATH =
      process.platform === "win32"
        ? (process.env.PATH ?? "")
        : "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
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
  const roots = [
    path.join(process.cwd(), "node_modules", "node-pty"),
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
      walkSpawnHelpers(path.join(root, sub), out);
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
