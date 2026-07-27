/**
 * On Windows, pull a Linux ripgrep binary so WSL workspaces can search on the
 * native Linux FS (Windows rg over \\wsl$ is ~10–50× slower via 9P).
 *
 * Writes: vendor/ripgrep-linux-<arch>/rg
 */
import {
  existsSync,
  mkdirSync,
  chmodSync,
  readdirSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = "1.18.0";
const arch = process.arch === "arm64" ? "arm64" : "x64";
const pkg = `@vscode/ripgrep-linux-${arch}`;
const outDir = path.join(root, "vendor", `ripgrep-linux-${arch}`);
const outRg = path.join(outDir, "rg");

if (process.platform !== "win32") {
  process.exit(0);
}

if (existsSync(outRg)) {
  console.log(`[ensure-wsl-rg] already present: ${outRg}`);
  process.exit(0);
}

try {
  mkdirSync(outDir, { recursive: true });
  const packDir = path.join(root, "vendor", ".tmp-rg-pack");
  mkdirSync(packDir, { recursive: true });
  console.log(`[ensure-wsl-rg] npm pack ${pkg}@${VERSION} …`);
  // shell:true — Windows spawn of npm.cmd needs it in some environments.
  execFileSync(
    `npm.cmd pack ${pkg}@${VERSION} --pack-destination "${packDir}"`,
    {
      cwd: root,
      stdio: "inherit",
      shell: true,
      env: { ...process.env, npm_config_force: "true" },
    },
  );
  const tgz = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error("npm pack produced no tgz");
  const tgzPath = path.join(packDir, tgz);
  const tarBin = existsSync("C:\\Windows\\System32\\tar.exe")
    ? "C:\\Windows\\System32\\tar.exe"
    : "tar";
  execFileSync(tarBin, ["-xzf", tgzPath, "-C", packDir], { stdio: "inherit" });

  const walk = (d) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, name.name);
      if (name.isDirectory()) {
        const f = walk(p);
        if (f) return f;
      } else if (name.name === "rg") {
        return p;
      }
    }
    return null;
  };
  const src =
    [
      path.join(packDir, "package", "bin", "rg"),
      path.join(packDir, "bin", "rg"),
    ].find((c) => existsSync(c)) || walk(packDir);
  if (!src || !existsSync(src)) throw new Error("rg binary not found in pack");
  copyFileSync(src, outRg);
  try {
    chmodSync(outRg, 0o755);
  } catch {
    // windows may ignore mode
  }
  try {
    rmSync(packDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  console.log(`[ensure-wsl-rg] wrote ${outRg}`);
} catch (err) {
  console.warn(
    `[ensure-wsl-rg] failed (WSL search will fall back to slower paths):`,
    err instanceof Error ? err.message : err,
  );
}
