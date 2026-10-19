import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ssh2 from "ssh2";
import { HostError } from "./types.js";

// ssh2 is CommonJS; utils is not exposed as a native ESM named export.
const { utils } = ssh2;

export interface SshKnownHostsOptions {
  host: string;
  port?: number;
  knownHostsPolicy?: "strict" | "accept-new" | "ignore";
  knownHostsFile?: string;
  /** Overrides are used by isolated fixture tests; profiles cannot override globals. */
  homeDirectory?: string;
  globalKnownHostsFiles?: readonly string[];
  signal?: AbortSignal;
}

interface KnownHostEntry {
  marker: string | undefined;
  key: Buffer;
  source: string;
}

// Serialize first-use writes within this process, including connections from
// different profiles. Always re-read trust records inside the critical section.
const pendingWrites = new Map<string, Promise<void>>();

export function knownHostName(host: string, port = 22): string {
  const hostname = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!hostname || /[\s\x00-\x1f\x7f,|*?!#[\]\\/]/.test(hostname) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HostError("failed", "Invalid SSH hostname or port for host key verification");
  }
  return port === 22 ? hostname.toLowerCase() : `[${hostname.toLowerCase()}]:${port}`;
}

export function sshKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

function keyType(key: Buffer): string {
  if (!Buffer.isBuffer(key) || key.length < 5) throw new Error("Malformed SSH host public key");
  const length = key.readUInt32BE(0);
  if (length < 1 || length > 256 || key.length < length + 4) throw new Error("Malformed SSH host public key");
  const type = key.subarray(4, 4 + length).toString("ascii");
  if (!/^[a-zA-Z0-9@._+-]+$/.test(type)) throw new Error("Malformed SSH host key type");
  if (type.includes("-cert-")) {
    throw new Error("SSH host certificates are not supported by manual SSH connections. Use an OpenSSH-config connection to validate the certificate authority");
  }
  const parsed = utils.parseKey(key);
  if (parsed instanceof Error || Array.isArray(parsed) || parsed.type !== type || !parsed.getPublicSSH().equals(key)) {
    throw new Error(`Malformed or unsupported SSH host public key (${type})`);
  }
  return type;
}

function decodeBase64(text: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new Error("Invalid base64 encoding");
  const result = Buffer.from(text, "base64");
  if (result.toString("base64").replace(/=+$/, "") !== text.replace(/=+$/, "")) {
    throw new Error("Invalid base64 encoding");
  }
  return result;
}

function hostMatches(patterns: string, hostname: string): boolean {
  if (patterns.startsWith("|")) {
    const parts = patterns.split("|");
    if (parts.length !== 4 || parts[1] !== "1") throw new Error("Unsupported hashed known_hosts hostname");
    const salt = decodeBase64(parts[2]);
    const expected = decodeBase64(parts[3]);
    if (salt.length !== 20 || expected.length !== 20) throw new Error("Malformed hashed known_hosts hostname");
    return timingSafeEqual(createHmac("sha1", salt).update(hostname).digest(), expected);
  }
  let positiveMatch = false;
  for (const pattern of patterns.split(",")) {
    const negated = pattern.startsWith("!");
    const value = negated ? pattern.slice(1) : pattern;
    // OpenSSH patterns only give special meaning to '*' and '?'. In particular,
    // square brackets in non-default-port records are literal characters.
    const regex = value.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    if (new RegExp(`^${regex}$`, "i").test(hostname)) {
      if (negated) return false;
      positiveMatch = true;
    }
  }
  return positiveMatch;
}

function parseMatchingEntries(contents: string, filename: string, hostname: string): KnownHostEntry[] {
  const entries: KnownHostEntry[] = [];
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const fields = trimmed.split(/\s+/);
    const marker = fields[0].startsWith("@") ? fields.shift() : undefined;
    const source = `${filename}:${index + 1}`;
    try {
      if (!fields[0] || !hostMatches(fields[0], hostname)) continue;
      if (marker && marker !== "@revoked" && marker !== "@cert-authority") {
        throw new Error(`Unsupported known_hosts marker ${marker}`);
      }
      if (fields.length < 3) throw new Error("Incomplete known_hosts entry");
      const key = decodeBase64(fields[2]);
      if (keyType(key) !== fields[1]) throw new Error("known_hosts key type does not match its public key");
      entries.push({ marker, key, source });
    } catch (error) {
      throw new HostError("permission", `Cannot verify SSH host ${hostname}: invalid known_hosts entry at ${source}. ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return entries;
}

function knownHostsPaths(options: SshKnownHostsOptions): { userFile: string; files: string[] } {
  const home = options.homeDirectory ?? os.homedir();
  const configured = options.knownHostsFile;
  if (configured !== undefined && (!configured.trim() || configured.includes("\0") || /^~[^/\\]/.test(configured))) {
    throw new HostError("failed", "Invalid SSH knownHostsFile path");
  }
  const userFile = configured
    ? path.resolve(configured.replace(/^~(?=[/\\]|$)/, home))
    : path.join(home, ".ssh", "known_hosts");
  const globalFiles = options.globalKnownHostsFiles ?? (process.platform === "win32"
    ? [path.join(process.env.ProgramData ?? "C:\\ProgramData", "ssh", "ssh_known_hosts")]
    : ["/etc/ssh/ssh_known_hosts", "/etc/ssh/ssh_known_hosts2"]);
  return {
    userFile,
    files: [...new Set([userFile, ...(!configured ? [path.join(home, ".ssh", "known_hosts2")] : []), ...globalFiles])],
  };
}

async function readKnownHosts(filename: string): Promise<string> {
  try {
    return await fs.readFile(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw new HostError("permission", `Cannot read SSH known_hosts file ${filename}. Host key verification was stopped.`, error instanceof Error ? error.message : String(error));
  }
}

/** Verify the raw ssh2 host key. Resolves only after trust checks and any opted-in
 * first-use persistence succeed. Never writes under strict (including legacy ignore).
 * Manual SSH does not interpret ssh_config; use the native transport for that.
 */
export async function verifySshHostKey(key: Buffer, options: SshKnownHostsOptions): Promise<void> {
  const hostname = knownHostName(options.host, options.port);
  let type: string;
  try {
    type = keyType(key);
  } catch (error) {
    throw new HostError("permission", `Cannot verify SSH host ${hostname}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const fingerprint = sshKeyFingerprint(key);
  const { userFile, files } = knownHostsPaths(options);
  const verify = async () => {
    options.signal?.throwIfAborted();
    const contents = await Promise.all(files.map(readKnownHosts));
    const entries = contents.flatMap((text, index) => parseMatchingEntries(text, files[index], hostname));
    const revoked = entries.find((entry) => entry.marker === "@revoked" && entry.key.equals(key));
    if (revoked) {
      throw new HostError("permission", `SSH host key for ${hostname} is revoked (${fingerprint}, ${revoked.source}). Connection refused.`);
    }
    if (entries.some((entry) => !entry.marker && entry.key.equals(key))) return;
    const authority = entries.find((entry) => entry.marker === "@cert-authority");
    if (authority) {
      throw new HostError("permission", `SSH certificate-authority verification for ${hostname} is not supported by manual SSH (${authority.source}). Use an OpenSSH-config connection. Presented key: ${fingerprint}.`);
    }
    if (entries.length) {
      throw new HostError("permission", `SSH host key changed for ${hostname}. Presented ${type} ${fingerprint}; existing trust at ${entries[0].source}. Connection refused. Verify the change with the server administrator before updating known_hosts in a terminal.`);
    }
    if (options.knownHostsPolicy !== "accept-new") {
      const legacy = options.knownHostsPolicy === "ignore" ? " The legacy ignore policy now enforces strict verification." : "";
      throw new HostError("permission", `Unknown SSH host key for ${hostname}: ${type} ${fingerprint}.${legacy} Verify this fingerprint with the server administrator, then connect using SSH in a terminal to record the verified key in ${userFile}, and retry.`);
    }
    options.signal?.throwIfAborted();
    try {
      await fs.mkdir(path.dirname(userFile), { recursive: true, mode: 0o700 });
      options.signal?.throwIfAborted();
      const file = await fs.open(userFile, "a", 0o600);
      try {
        if (!(await file.stat()).isFile()) throw new Error("knownHostsFile must be a regular file");
        options.signal?.throwIfAborted();
        // A leading newline also preserves a pre-existing final line without EOL.
        await file.appendFile(`\n${hostname} ${type} ${key.toString("base64")}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (error) {
      throw new HostError("permission", `Cannot save new SSH host key for ${hostname} (${fingerprint}) to ${userFile}. Connection refused.`, error instanceof Error ? error.message : String(error));
    }
  };
  if (options.knownHostsPolicy !== "accept-new") return verify();
  const previous = pendingWrites.get(userFile) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(verify);
  pendingWrites.set(userFile, operation);
  try {
    await operation;
  } finally {
    if (pendingWrites.get(userFile) === operation) pendingWrites.delete(userFile);
  }
}
