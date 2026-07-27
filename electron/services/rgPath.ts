/**
 * Resolve a ripgrep binary for local content search.
 * Prefer the platform package shipped with @vscode/ripgrep (same approach as VS Code);
 * fall back to PATH. Remote hosts (WSL/SSH) must use the remote's `rg`.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

let cachedLocal: string | null | undefined;

/** Electron asar cannot execute binaries; point at the unpacked copy. */
export function unpackAsarPath(p: string): string {
  // Both slash styles appear across platforms / packaging.
  if (p.includes(`app.asar${path.sep}`) || p.includes("app.asar/")) {
    return p.replace("app.asar", "app.asar.unpacked");
  }
  return p;
}

/**
 * Absolute path to a local rg binary, or null if none is available on this machine.
 * Result is cached for the process lifetime.
 */
export function resolveLocalRgPath(): string | null {
  if (cachedLocal !== undefined) return cachedLocal;

  // 1) Bundled binary (optionalDependency per platform).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@vscode/ripgrep") as { rgPath: string };
    const candidate = unpackAsarPath(mod.rgPath);
    if (candidate && existsSync(candidate)) {
      cachedLocal = candidate;
      return cachedLocal;
    }
  } catch {
    // package missing or wrong platform — fall through
  }

  // 2) Common install locations (PATH may not include them in Electron).
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const extras: string[] =
    process.platform === "win32"
      ? [
          path.join(home, "scoop", "shims", "rg.exe"),
          path.join(home, "scoop", "apps", "ripgrep", "current", "rg.exe"),
          "C:\\ProgramData\\chocolatey\\bin\\rg.exe",
        ]
      : [
          "/opt/homebrew/bin/rg",
          "/usr/local/bin/rg",
          path.join(home, ".cargo", "bin", "rg"),
        ];
  for (const c of extras) {
    if (c && existsSync(c)) {
      cachedLocal = c;
      return cachedLocal;
    }
  }

  // 3) Leave PATH lookup to spawn("rg") — we signal "try path name" via empty-string convention? No:
  // callers treat null as "no absolute path"; they may still try command name "rg".
  cachedLocal = null;
  return null;
}

/** Test helper: clear process-local cache. */
export function _resetLocalRgPathCacheForTests(): void {
  cachedLocal = undefined;
}
