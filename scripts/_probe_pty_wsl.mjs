/**
 * Probe: can electron+node-pty spawn wsl.exe?
 * Run: ELECTRON_RUN_AS_NODE=1 electron scripts/_probe_pty_wsl.mjs
 * or:  node -e "..." spawn electron with ELECTRON_RUN_AS_NODE
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const candidates = [
  path.join(__dirname, "..", "node_modules", "node-pty"),
  path.join(
    process.cwd(),
    "release",
    "win-unpacked",
    "resources",
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
  ),
];

let pty;
let loadedFrom = "";
for (const c of candidates) {
  try {
    pty = require(c);
    loadedFrom = c;
    break;
  } catch (err) {
    console.error("load fail", c, err instanceof Error ? err.message : err);
  }
}
if (!pty) {
  console.error("node-pty not loadable");
  process.exit(4);
}
console.log("loaded", loadedFrom);

const wsl = process.env.SystemRoot
  ? `${process.env.SystemRoot}\\System32\\wsl.exe`
  : "wsl.exe";

console.log("spawning", wsl);
const env = {
  SystemRoot: process.env.SystemRoot || "C:\\Windows",
  PATH: process.env.PATH || "",
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
};

try {
  const p = pty.spawn(
    wsl,
    ["-d", "Ubuntu-24.04", "--cd", "/home", "--", "bash", "-lc", "echo PTY_OK; pwd; sleep 0.3"],
    {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: process.env.USERPROFILE || "C:\\",
      env,
    },
  );
  p.onData((d) => process.stdout.write(d));
  p.onExit(({ exitCode }) => {
    console.log("\nEXIT", exitCode);
    process.exit(exitCode === 0 ? 0 : 1);
  });
  setTimeout(() => {
    console.log("\nTIMEOUT");
    try {
      p.kill();
    } catch {
      // ignore
    }
    process.exit(2);
  }, 15000);
} catch (err) {
  console.error("SPAWNERR", err);
  process.exit(3);
}
