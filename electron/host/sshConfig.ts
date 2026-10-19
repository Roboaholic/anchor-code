import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface SshConfigHost {
  alias: string;
  source: string;
}

export interface SshConfigHosts {
  hosts: SshConfigHost[];
  warnings: string[];
}

/** Discovery only: OpenSSH itself resolves all connection options at connection time. */
export async function listSshConfigHosts(options: {
  home?: string;
  userConfig?: string;
  systemConfig?: string;
} = {}): Promise<SshConfigHosts> {
  const home = options.home ?? os.homedir();
  const userBase = path.join(home, ".ssh");
  const systemConfig = options.systemConfig ?? (process.platform === "win32"
    ? path.join(process.env.ProgramData || "C:\\ProgramData", "ssh", "ssh_config")
    : "/etc/ssh/ssh_config");
  const result: SshConfigHosts = { hosts: [], warnings: [] };
  const visited = new Set<string>();
  const aliases = new Set<string>();

  const scan = async (file: string, base: string, depth: number): Promise<void> => {
    if (depth > 16 || visited.size >= 256) {
      if (!result.warnings.includes("SSH config Include limit reached; type an alias to use it directly.")) {
        result.warnings.push("SSH config Include limit reached; type an alias to use it directly.");
      }
      return;
    }
    let real: string;
    try {
      real = await fs.realpath(file);
      if (visited.has(real)) return;
      visited.add(real);
      const stat = await fs.stat(real);
      if (!stat.isFile() || stat.size > 1024 * 1024) {
        result.warnings.push(`Skipped oversized or non-file SSH config: ${file}`);
        return;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") result.warnings.push(`Cannot read SSH config: ${file}`);
      return;
    }
    let contents: string;
    try { contents = await fs.readFile(real, "utf8"); }
    catch { result.warnings.push(`Cannot read SSH config: ${file}`); return; }
    for (const line of contents.split(/\r?\n/)) {
      const words = tokenizeConfigLine(line);
      const directive = words.shift()?.toLowerCase();
      if (directive === "host") {
        for (const alias of words) {
          if (!isSshConfigAlias(alias) || aliases.has(alias.toLowerCase())) continue;
          aliases.add(alias.toLowerCase());
          result.hosts.push({ alias, source: file });
        }
      } else if (directive === "include") {
        for (const item of words) {
          const expanded = item === "~" ? home : item.startsWith("~/") ? path.join(home, item.slice(2)) : item;
          // ~otheruser and percent/environment expansions cannot be safely inferred here.
          if (expanded.startsWith("~") || expanded.includes("${") || expanded.includes("%")) {
            result.warnings.push(`Cannot enumerate Include ${item}; type its host alias directly.`);
            continue;
          }
          try {
            const absolute = path.isAbsolute(expanded) ? expanded : path.join(base, expanded);
            const matches: string[] = [];
            for await (const match of fs.glob(absolute.replaceAll("\\", "/"))) matches.push(match);
            for (const match of matches.sort()) await scan(match, base, depth + 1);
          } catch { result.warnings.push(`Cannot enumerate SSH Include: ${item}`); }
        }
      }
    }
  };
  await scan(options.userConfig ?? path.join(userBase, "config"), userBase, 0);
  await scan(systemConfig, path.dirname(systemConfig), 0);
  return result;
}

/** Only literal destinations, never command-line options or Host patterns. */
export function isSshConfigAlias(value: string): boolean {
  return /^[a-zA-Z0-9:][a-zA-Z0-9._:@%+-]*$/.test(value);
}

/** SSH config supports quoted whitespace, backslash escapes, comments and key=value. */
export function tokenizeConfigLine(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote = "";
  let escaped = false;
  let started = false;
  for (const c of line) {
    if (escaped) { word += c; escaped = false; started = true; continue; }
    if (c === "\\") { escaped = true; continue; }
    if (quote) {
      if (c === quote) quote = "";
      else word += c;
      started = true;
    } else if (c === '"' || c === "'") {
      quote = c; started = true;
    } else if (c === "#") {
      break;
    } else if (/\s/.test(c) || (c === "=" && words.length === 0)) {
      if (started) { words.push(word); word = ""; started = false; }
    } else { word += c; started = true; }
  }
  if (quote || escaped) return []; // Malformed declarations are left to OpenSSH to diagnose.
  if (started) words.push(word);
  return words;
}
