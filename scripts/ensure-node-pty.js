/**
 * node-pty ships prebuild spawn-helper without execute bits on some npm installs.
 * That yields: Error: posix_spawnp failed when opening a PTY.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "node_modules",
  "node-pty",
);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (name === "spawn-helper") out.push(p);
  }
  return out;
}

const helpers = [
  ...walk(path.join(root, "prebuilds")),
  ...walk(path.join(root, "build")),
];

let fixed = 0;
for (const helper of helpers) {
  try {
    const mode = fs.statSync(helper).mode;
    // Ensure owner execute bit
    if ((mode & 0o111) === 0) {
      fs.chmodSync(helper, mode | 0o755);
      fixed += 1;
      console.log("[ensure-node-pty] chmod +x", helper);
    }
  } catch (err) {
    console.warn("[ensure-node-pty] skip", helper, err);
  }
}

if (helpers.length === 0) {
  console.warn(
    "[ensure-node-pty] no spawn-helper found under node_modules/node-pty (install node-pty first)",
  );
} else if (fixed === 0) {
  console.log(
    `[ensure-node-pty] ${helpers.length} spawn-helper(s) already executable`,
  );
} else {
  console.log(`[ensure-node-pty] fixed ${fixed} spawn-helper(s)`);
}
