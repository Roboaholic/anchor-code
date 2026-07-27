/**
 * Resolve ripgrep binaries for content search.
 * - Local Windows/macOS/Linux: @vscode/ripgrep platform package
 * - WSL from Windows host: Linux binary (vendor/ or @vscode/ripgrep-linux-*),
 *   invoked *inside* the distro — never Windows rg over \\wsl$\ (9P is ~10–50× slower)
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

let cachedLocal: string | null | undefined;
let cachedLinuxWinPath: string | null | undefined;

/** Electron asar cannot execute binaries; point at the unpacked copy. */
export function unpackAsarPath(p: string): string {
  if (p.includes(`app.asar${path.sep}`) || p.includes("app.asar/")) {
    return p.replace("app.asar", "app.asar.unpacked");
  }
  return p;
}

/**
 * Convert a Windows absolute path to a WSL /mnt/<drive>/… path.
 * Non-Windows paths returned with forward slashes only.
 */
export function windowsPathToWsl(winPath: string): string {
  const normalized = winPath.replace(/\\/g, "/");
  const m = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (m) {
    return `/mnt/${m[1]!.toLowerCase()}/${m[2]}`;
  }
  // Already POSIX or UNC — leave as-is (UNC is not usable inside WSL this way)
  return normalized;
}

/**
 * Absolute path to a local (host OS) rg binary, or null.
 */
export function resolveLocalRgPath(): string | null {
  if (cachedLocal !== undefined) return cachedLocal;

  try {
    const mod = require("@vscode/ripgrep") as { rgPath: string };
    const candidate = unpackAsarPath(mod.rgPath);
    if (candidate && existsSync(candidate)) {
      cachedLocal = candidate;
      return cachedLocal;
    }
  } catch {
    // package missing or wrong platform
  }

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

  cachedLocal = null;
  return null;
}

/**
 * Windows absolute path to a Linux x64/arm64 rg binary we can exec *inside WSL*
 * via /mnt/c/…, or null.
 */
export function resolveLinuxRgWindowsPath(): string | null {
  if (cachedLinuxWinPath !== undefined) return cachedLinuxWinPath;
  if (process.platform !== "win32") {
    cachedLinuxWinPath = null;
    return null;
  }

  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const candidates: string[] = [];

  // 1) vendor/ from postinstall or electron-builder extraResources
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const roots = [
      // Packaged: process.resourcesPath/vendor/…
      typeof process.resourcesPath === "string" ? process.resourcesPath : "",
      path.resolve(here, "../.."),
      path.resolve(here, "../../.."),
      process.cwd(),
    ].filter(Boolean);
    for (const root of roots) {
      candidates.push(
        path.join(root, "vendor", `ripgrep-linux-${arch}`, "rg"),
        path.join(root, "resources", "vendor", `ripgrep-linux-${arch}`, "rg"),
      );
    }
  } catch {
    // ignore
  }

  // 2) npm optional / force-installed platform packages
  const pkgNames = [
    `@vscode/ripgrep-linux-${arch}`,
    // older layouts
    `@vscode/ripgrep-linux-${arch === "x64" ? "x64" : "arm64"}`,
  ];
  for (const name of pkgNames) {
    try {
      const resolved = require.resolve(`${name}/package.json`);
      candidates.push(path.join(path.dirname(resolved), "bin", "rg"));
    } catch {
      // not installed
    }
  }

  for (const c of candidates) {
    const p = unpackAsarPath(c);
    if (p && existsSync(p)) {
      cachedLinuxWinPath = p;
      return cachedLinuxWinPath;
    }
  }

  cachedLinuxWinPath = null;
  return null;
}

/**
 * Path to invoke Linux rg *from inside WSL* (e.g. /mnt/c/…/rg).
 */
export function resolveWslLinuxRgPath(): string | null {
  const win = resolveLinuxRgWindowsPath();
  if (!win) return null;
  return windowsPathToWsl(win);
}

/** Test helper: clear process-local caches. */
export function _resetLocalRgPathCacheForTests(): void {
  cachedLocal = undefined;
  cachedLinuxWinPath = undefined;
}
