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

  const env = opts?.env ?? buildPtyEnv();
  const shell = resolveExecutable(opts?.shell ?? resolveShell(), env);
  const args = opts?.args ?? shellArgs(shell);
  const safeCwd = resolveCwd(cwd);
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
          formatSpawnFailure(
            shell,
            safeCwd,
            err2 instanceof Error ? err2.message : String(err2),
          ),
        );
      }
    } else {
      throw new HostError(
        "failed",
        formatSpawnFailure(shell, safeCwd, msg),
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
  if (process.platform === "win32") {
    env.PATH = mergeWindowsPath(env.PATH || process.env.PATH || "");
    // Git fetch/push often look "dead" in an Electron-hosted PTY because:
    // 1) Credential Manager needs an interactive UI (browser/dialog)
    // 2) up-to-date fetch prints almost nothing
    // Force interactive credential prompts when possible.
    if (!env.GCM_INTERACTIVE) env.GCM_INTERACTIVE = "always";
    if (!env.GIT_TERMINAL_PROMPT) env.GIT_TERMINAL_PROMPT = "1";
    // Prefer the Windows Git credential manager UI over a blank TTY wait.
    if (!env.GIT_ASKPASS && !env.SSH_ASKPASS) {
      // Leave unset so GCM/schannel can use their native UI; do not force
      // a missing askpass helper that would hang with no terminal output.
    }
  } else if (!env.PATH || env.PATH.length < 8) {
    env.PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  }
  return env;
}

/** Agent CLIs often install under user dirs not present in Electron's PATH. */
function mergeWindowsPath(pathEnv: string): string {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const extras = [
    home ? path.join(home, ".grok", "bin") : "",
    home ? path.join(home, ".local", "bin") : "",
    home ? path.join(home, "AppData", "Local", "omp") : "",
    home ? path.join(home, "AppData", "Roaming", "npm") : "",
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin")
      : "",
  ].filter(Boolean);
  const parts = pathEnv.split(";").filter(Boolean);
  const lower = new Set(parts.map((p) => p.toLowerCase()));
  for (const e of extras) {
    if (!lower.has(e.toLowerCase()) && fs.existsSync(e)) {
      parts.unshift(e);
      lower.add(e.toLowerCase());
    }
  }
  return parts.join(";");
}

/**
 * Resolve a bare command to an absolute path when possible.
 * node-pty on Windows fails with "File not found" for names not on PATH
 * even when the binary exists under a known install dir.
 */
function resolveExecutable(
  command: string,
  env: Record<string, string>,
): string {
  const cmd = command.trim();
  if (!cmd) return cmd;
  if (/[\\/]/.test(cmd) || /\.(exe|cmd|bat|ps1)$/i.test(cmd)) {
    return cmd;
  }
  if (process.platform !== "win32") return cmd;

  const home = process.env.USERPROFILE || process.env.HOME || "";
  const candidates = [
    home ? path.join(home, ".grok", "bin", `${cmd}.exe`) : "",
    home ? path.join(home, ".grok", "bin", cmd) : "",
    home ? path.join(home, ".local", "bin", `${cmd}.exe`) : "",
    home ? path.join(home, "AppData", "Local", "omp", `${cmd}.exe`) : "",
    home ? path.join(home, "AppData", "Local", "omp", cmd) : "",
    home ? path.join(home, "AppData", "Roaming", "npm", `${cmd}.cmd`) : "",
    home ? path.join(home, "AppData", "Roaming", "npm", cmd) : "",
    process.env.LOCALAPPDATA
      ? path.join(
          process.env.LOCALAPPDATA,
          "Programs",
          "OpenAI",
          "Codex",
          "bin",
          `${cmd}.exe`,
        )
      : "",
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {
      // continue
    }
  }

  // Scan PATH entries for cmd / cmd.exe / cmd.cmd
  const pathEnv = env.PATH || process.env.PATH || "";
  const exts = (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter(Boolean);
  for (const dir of pathEnv.split(";").filter(Boolean)) {
    for (const ext of ["", ...exts]) {
      const full = path.join(dir, `${cmd}${ext}`);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
      } catch {
        // continue
      }
    }
  }
  return cmd;
}

function formatSpawnFailure(
  shell: string,
  cwd: string,
  detail: string,
): string {
  const base = shellDisplayName(shell);
  const looksMissing =
    /ENOENT|not found|File not found|The system cannot find/i.test(detail);
  const bareName = !/[\\/]/.test(shell) && !/\.(exe|cmd|bat|ps1)$/i.test(shell);
  if (looksMissing && bareName && process.platform === "win32") {
    const home = process.env.USERPROFILE || "";
    const hint = home
      ? path.join(home, ".grok", "bin", `${base}.exe`)
      : "";
    const installed =
      hint && fs.existsSync(hint)
        ? `\nFound install at ${hint} but it was not resolved — restart Anchor after upgrade.`
        : "";
    return (
      `Failed to start agent CLI "${base}" in ${cwd}: not found on Windows PATH.\n` +
      `\n` +
      `On Windows, Agent sessions spawn native processes (node-pty), not WSL.\n` +
      `• Install location often used: %USERPROFILE%\\.grok\\bin\\${base}.exe\n` +
      `• Or open the workspace via WSL host if the CLI lives only inside WSL.\n` +
      installed +
      `\nDetail: ${detail.trim() || "(empty)"}`
    );
  }
  if (looksMissing) {
    return (
      `Failed to start shell (${shell}) in ${cwd}: executable not found.\n` +
      `Detail: ${detail.trim() || "(empty)"}`
    );
  }
  return (
    `Failed to start shell (${shell}) in ${cwd}: ${detail}` +
    (process.platform === "win32"
      ? ""
      : ". If this persists: npm run rebuild:native && npm run ensure:pty")
  );
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
