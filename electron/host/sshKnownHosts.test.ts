import { createHash, createHmac } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { knownHostName, sshKeyFingerprint, verifySshHostKey, type SshKnownHostsOptions } from "./sshKnownHosts.js";

function sshString(value: string | Buffer): Buffer {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

const key = Buffer.concat([sshString("ssh-ed25519"), sshString(Buffer.alloc(32, 1))]);
const otherKey = Buffer.concat([sshString("ssh-ed25519"), sshString(Buffer.alloc(32, 2))]);
const line = (hostname = "server.example", publicKey = key) => `${hostname} ssh-ed25519 ${publicKey.toString("base64")}`;
const hashedName = (hostname: string) => {
  const salt = Buffer.alloc(20, 5);
  return `|1|${salt.toString("base64")}|${createHmac("sha1", salt).update(hostname).digest("base64")}`;
};

describe("SSH known_hosts verification (isolated fixtures)", () => {
  let tmp: string;
  let userFile: string;
  let globalFile: string;
  let options: SshKnownHostsOptions;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "anchor-known-hosts-"));
    userFile = path.join(tmp, ".ssh", "known_hosts");
    globalFile = path.join(tmp, "system_known_hosts");
    options = { host: "server.example", homeDirectory: tmp, globalKnownHostsFiles: [globalFile] };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function write(text: string, filename = userFile) {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, text);
  }

  it("uses OpenSSH host and non-default-port spelling, including IPv6", () => {
    expect(knownHostName("SERVER.example")).toBe("server.example");
    expect(knownHostName("server.example", 2222)).toBe("[server.example]:2222");
    expect(knownHostName("[2001:db8::1]")).toBe("2001:db8::1");
    expect(knownHostName("2001:db8::1", 2222)).toBe("[2001:db8::1]:2222");
  });

  it.each(["server\nexample", "server\0example", "*.example", "a,b", "!server", "", "[broken"])("rejects unsafe hostname %j", (hostname) => {
    expect(() => knownHostName(hostname)).toThrow("Invalid SSH hostname");
  });

  it("computes an OpenSSH SHA256 fingerprint without base64 padding", () => {
    expect(sshKeyFingerprint(key)).toBe(`SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`);
  });

  it("defaults to strict, verifies a pinned key, and does not rewrite it", async () => {
    const original = `# existing trust\n${line()} fixture\n`;
    await write(original);
    await expect(verifySshHostKey(key, options)).resolves.toBeUndefined();
    expect(await fs.readFile(userFile, "utf8")).toBe(original);
  });

  it("rejects unknown hosts with fingerprint and terminal guidance without creating files", async () => {
    await expect(verifySshHostKey(key, options)).rejects.toThrow(`Unknown SSH host key for server.example: ssh-ed25519 ${sshKeyFingerprint(key)}`);
    await expect(verifySshHostKey(key, options)).rejects.toThrow("SSH in a terminal");
    await expect(fs.stat(path.dirname(userFile))).rejects.toHaveProperty("code", "ENOENT");
  });

  it("treats legacy ignore as strict, with an explanation instead of bypassing trust", async () => {
    await expect(verifySshHostKey(key, { ...options, knownHostsPolicy: "ignore" })).rejects.toThrow("legacy ignore policy now enforces strict");
    await write(line());
    await expect(verifySshHostKey(key, { ...options, knownHostsPolicy: "ignore" })).resolves.toBeUndefined();
  });

  it.each(["strict", "accept-new", "ignore"] as const)("rejects a changed key under %s without changing trust", async (knownHostsPolicy) => {
    await write(line());
    await expect(verifySshHostKey(otherKey, { ...options, knownHostsPolicy })).rejects.toThrow(`SSH host key changed for server.example. Presented ssh-ed25519 ${sshKeyFingerprint(otherKey)}`);
    expect(await fs.readFile(userFile, "utf8")).toBe(line());
  });

  it("matches hashed hostnames", async () => {
    await write(line(hashedName("server.example")));
    await expect(verifySshHostKey(key, options)).resolves.toBeUndefined();
    await expect(verifySshHostKey(otherKey, { ...options, knownHostsPolicy: "accept-new" })).rejects.toThrow("host key changed");
  });

  it.each([false, true])("matches non-default ports, hashed=%s, without trusting port 22", async (hashed) => {
    const hostname = "[server.example]:2222";
    await write(line(hashed ? hashedName(hostname) : hostname));
    await expect(verifySshHostKey(key, { ...options, port: 2222 })).resolves.toBeUndefined();
    await expect(verifySshHostKey(key, options)).rejects.toThrow("Unknown SSH host key");
  });

  it("supports comma-separated names, case-insensitive patterns, and negation", async () => {
    await write(line("alias,*.EXAMPLE,!bad.example"));
    await expect(verifySshHostKey(key, options)).resolves.toBeUndefined();
    await expect(verifySshHostKey(key, { ...options, host: "alias" })).resolves.toBeUndefined();
    await expect(verifySshHostKey(key, { ...options, host: "bad.example" })).rejects.toThrow("Unknown SSH host key");
  });

  it("accepts a key from system known_hosts without creating a user file", async () => {
    await write(line(), globalFile);
    await expect(verifySshHostKey(key, { ...options, knownHostsPolicy: "accept-new" })).resolves.toBeUndefined();
    await expect(fs.stat(userFile)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("also reads the legacy per-user known_hosts2 file", async () => {
    await write(line(), `${userFile}2`);
    await expect(verifySshHostKey(key, options)).resolves.toBeUndefined();
  });

  it("allows a matching key among multiple valid host records", async () => {
    await write(`${line("server.example", otherKey)}\n${line()}\n`);
    await expect(verifySshHostKey(key, options)).resolves.toBeUndefined();
  });

  it("lets revocation override a trusted key in any file", async () => {
    await write(line());
    await write(`@revoked ${line("*")}`, globalFile);
    await expect(verifySshHostKey(key, { ...options, knownHostsPolicy: "accept-new" })).rejects.toThrow("is revoked");
    expect(await fs.readFile(userFile, "utf8")).toBe(line());
  });

  it("does not mistake a revoked previous key for a new unknown host", async () => {
    await write(`@revoked ${line()}`);
    await expect(verifySshHostKey(otherKey, { ...options, knownHostsPolicy: "accept-new" })).rejects.toThrow("host key changed");
  });

  it("explicitly refuses unsupported certificate-authority trust without persisting a key", async () => {
    await write(`@cert-authority ${line("*.example")}`);
    await expect(verifySshHostKey(key, { ...options, knownHostsPolicy: "accept-new" })).rejects.toThrow("Use an OpenSSH-config connection");
    expect(await fs.readFile(userFile, "utf8")).toBe(`@cert-authority ${line("*.example")}`);
  });

  it("explicitly refuses presented host certificates", async () => {
    const certificate = Buffer.concat([sshString("ssh-ed25519-cert-v01@openssh.com"), sshString(Buffer.alloc(32, 1))]);
    await expect(verifySshHostKey(certificate, options)).rejects.toThrow("host certificates are not supported");
  });

  it.each([
    `server.example ssh-rsa ${key.toString("base64")}`,
    "server.example ssh-ed25519 not-base64!",
    "server.example ssh-ed25519",
    `@unexpected ${line()}`,
    `${line()}=`.replace("ssh-ed25519", "ssh-rsa"),
  ])("fails closed on malformed matching records: %s", async (record) => {
    await write(record);
    await expect(verifySshHostKey(key, { ...options, knownHostsPolicy: "accept-new" })).rejects.toThrow("invalid known_hosts entry");
    expect(await fs.readFile(userFile, "utf8")).toBe(record);
  });

  it("ignores unrelated malformed entries and comments", async () => {
    await write(`# comment\nother.example not-a-key\n${line()}\n`);
    await expect(verifySshHostKey(key, options)).resolves.toBeUndefined();
  });

  it("refuses malformed presented keys, including trailing bytes", async () => {
    for (const invalid of [Buffer.from("invalid"), Buffer.concat([key, Buffer.from([1])])]) {
      await expect(verifySshHostKey(invalid, { ...options, knownHostsPolicy: "accept-new" })).rejects.toThrow("Cannot verify SSH host");
    }
    await expect(fs.stat(userFile)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("fails closed if a trust file cannot be read, even with a trusted user key", async () => {
    await write(line());
    await fs.mkdir(globalFile);
    await expect(verifySshHostKey(key, options)).rejects.toThrow("Cannot read SSH known_hosts file");
  });

  it("persists a first-use key only when accept-new is explicitly requested", async () => {
    await verifySshHostKey(key, { ...options, knownHostsPolicy: "accept-new" });
    expect((await fs.readFile(userFile, "utf8")).trim()).toBe(line());
    await expect(verifySshHostKey(key, options)).resolves.toBeUndefined();
    if (process.platform !== "win32") {
      expect((await fs.stat(userFile)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.dirname(userFile))).mode & 0o777).toBe(0o700);
    }
  });

  it("appends only to the configured file and preserves existing final lines without EOL", async () => {
    const configuredFile = path.join(tmp, "custom", "known_hosts");
    await write("# existing comment", configuredFile);
    const custom = { ...options, knownHostsFile: "~/custom/known_hosts", knownHostsPolicy: "accept-new" as const };
    await verifySshHostKey(key, custom);
    const saved = await fs.readFile(configuredFile, "utf8");
    expect(saved).toBe(`# existing comment\n${line()}\n`);
    await verifySshHostKey(key, custom);
    expect(await fs.readFile(configuredFile, "utf8")).toBe(saved);
    await expect(fs.stat(userFile)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("does not bypass system revocations when a custom file is used", async () => {
    await write(`@revoked ${line()}`, globalFile);
    const configuredFile = path.join(tmp, "custom_known_hosts");
    await expect(verifySshHostKey(key, { ...options, knownHostsFile: configuredFile, knownHostsPolicy: "accept-new" })).rejects.toThrow("is revoked");
    await expect(fs.stat(configuredFile)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("serializes parallel first-use writes and does not duplicate a key", async () => {
    await Promise.all(Array.from({ length: 5 }, () => verifySshHostKey(key, { ...options, knownHostsPolicy: "accept-new" })));
    expect((await fs.readFile(userFile, "utf8")).trim()).toBe(line());
  });

  it("rejects a competing different first-use key after the first key is recorded", async () => {
    const results = await Promise.allSettled([key, otherKey].map((value) => verifySshHostKey(value, { ...options, knownHostsPolicy: "accept-new" })));
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    expect((results[1] as PromiseRejectedResult).reason.message).toContain("host key changed");
    expect((await fs.readFile(userFile, "utf8")).trim()).toBe(line());
  });

  it("does not persist first-use keys after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(verifySshHostKey(key, { ...options, knownHostsPolicy: "accept-new", signal: controller.signal })).rejects.toThrow();
    await expect(fs.stat(userFile)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("refuses an unknown key if persistence fails and permits a clean retry", async () => {
    vi.spyOn(fs, "open").mockRejectedValueOnce(new Error("fixture disk failure"));
    const acceptNew = { ...options, knownHostsPolicy: "accept-new" as const };
    await expect(verifySshHostKey(key, acceptNew)).rejects.toThrow(`Cannot save new SSH host key for server.example (${sshKeyFingerprint(key)})`);
    await expect(fs.stat(userFile)).rejects.toHaveProperty("code", "ENOENT");
    await expect(verifySshHostKey(key, acceptNew)).resolves.toBeUndefined();
    expect((await fs.readFile(userFile, "utf8")).trim()).toBe(line());
  });
});
