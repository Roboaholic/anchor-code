import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ConnectConfig } from "ssh2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostError } from "./types.js";
import { SshHostSession, type SshHostOptions } from "./sshHost.js";

const mocks = vi.hoisted(() => ({
  verify: vi.fn<(...args: unknown[]) => Promise<void>>(),
  configs: [] as ConnectConfig[],
  readyCount: 0,
  sftpOpen: vi.fn(),
  sftpRead: vi.fn(),
  sftpClose: vi.fn(),
  sftpReadFile: vi.fn(),
}));

vi.mock("./sshKnownHosts.js", () => ({ verifySshHostKey: mocks.verify }));
vi.mock("ssh2", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Client: class extends EventEmitter {
      connect(config: ConnectConfig) {
        mocks.configs.push(config);
        const verifier = config.hostVerifier as (key: Buffer, callback: (accepted: boolean) => void) => void;
        verifier(Buffer.from("fixture-host-key"), (accepted) => {
          if (accepted) {
            mocks.readyCount++;
            this.emit("ready");
          } else {
            this.emit("error", new Error("Host denied (verification failed)"));
          }
        });
        return this;
      }
      sftp(callback: (error: null, sftp: unknown) => void) {
        callback(null, {
          readFile(_file: string, _encoding: string, done: (error: null, text: string) => void) {
            mocks.sftpReadFile();
            done(null, "fixture contents");
          },
          open: mocks.sftpOpen,
          read: mocks.sftpRead,
          close: mocks.sftpClose,
        });
      }
      end() {
        this.emit("end");
        this.emit("close");
      }
    },
  };
});

describe("manual SSH host verification wiring (no live SSH)", () => {
  let session: SshHostSession;
  const base: SshHostOptions = { profileId: "fixture", host: "server.example", username: "fixture-user" };

  beforeEach(() => {
    mocks.verify.mockReset().mockResolvedValue(undefined);
    mocks.configs.length = 0;
    mocks.readyCount = 0;
    mocks.sftpReadFile.mockClear();
    mocks.sftpOpen.mockReset().mockImplementation((_path, _flags, done) => done(null, Buffer.from("handle")));
    mocks.sftpRead.mockReset();
    mocks.sftpClose.mockReset().mockImplementation((_handle, done) => done(null));
  });

  afterEach(async () => {
    await session?.dispose();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("always installs a raw-key verifier and forwards the trust target", async () => {
    session = new SshHostSession({ ...base, port: 2222, knownHostsFile: "/fixture/known_hosts" });
    await expect(session.readFile("/file")).resolves.toBe("fixture contents");
    expect(mocks.configs[0].hostVerifier).toBeTypeOf("function");
    expect(mocks.configs[0].hostHash).toBeUndefined();
    expect(mocks.verify).toHaveBeenCalledWith(Buffer.from("fixture-host-key"), expect.objectContaining({
      host: "server.example", port: 2222, knownHostsPolicy: undefined, knownHostsFile: "/fixture/known_hosts",
    }));
  });

  it("uses bounded SFTP reads, handles short reads and closes the handle", async () => {
    const bytes = Buffer.from("abc中文🦊" + "x".repeat(1024));
    let totalRead = 0;
    mocks.sftpRead.mockImplementation((_handle, buffer, offset, length, position, done) => {
      const count = Math.min(2, length, bytes.length - position);
      bytes.copy(buffer, offset, position, position + count);
      totalRead += count;
      done(null, count);
    });
    session = new SshHostSession(base);
    expect(await session.readFile("/file", { maxBytes: 8 })).toBe("abc中");
    expect(totalRead).toBe(9);
    expect(mocks.sftpReadFile).not.toHaveBeenCalled();
    expect(mocks.sftpClose).toHaveBeenCalledOnce();
  });

  it("closes bounded SFTP handles after read failures and preserves permission errors", async () => {
    mocks.sftpRead.mockImplementation((_handle, _buffer, _offset, _length, _position, done) =>
      done(Object.assign(new Error("Permission denied"), { code: 3 })));
    session = new SshHostSession(base);
    await expect(session.readFile("/file", { maxBytes: 100 })).rejects.toMatchObject({ code: "permission" });
    expect(mocks.sftpClose).toHaveBeenCalledOnce();
  });

  it.each([undefined, "strict", "accept-new", "ignore"] as const)("does not proceed on trust failure with policy %s", async (knownHostsPolicy) => {
    const failure = new HostError("permission", "Unknown SSH host key: SHA256:fixture. Verify in a terminal.");
    mocks.verify.mockRejectedValue(failure);
    session = new SshHostSession({ ...base, knownHostsPolicy });
    await expect(session.readFile("/file")).rejects.toBe(failure);
    expect(mocks.readyCount).toBe(0);
  });

  it("preserves SSH_AUTH_SOCK agent authentication", async () => {
    vi.stubEnv("SSH_AUTH_SOCK", "/fixture/agent.sock");
    session = new SshHostSession(base);
    await session.readFile("/file");
    expect(mocks.configs[0].agent).toBe("/fixture/agent.sock");
  });

  it("preserves password authentication", async () => {
    vi.stubEnv("SSH_AUTH_SOCK", "/fixture/agent.sock");
    session = new SshHostSession({ ...base, password: "fixture-password" });
    await session.readFile("/file");
    expect(mocks.configs[0].password).toBe("fixture-password");
    expect(mocks.configs[0].agent).toBeUndefined();
  });

  it("preserves inline key and passphrase authentication", async () => {
    session = new SshHostSession({ ...base, privateKey: "fixture-key", passphrase: "fixture-passphrase", password: "unused" });
    await session.readFile("/file");
    expect(mocks.configs[0]).toMatchObject({ privateKey: "fixture-key", passphrase: "fixture-passphrase" });
    expect(mocks.configs[0].password).toBeUndefined();
    expect(mocks.configs[0].agent).toBeUndefined();
  });

  it("preserves local private-key-file authentication using a temporary fixture", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "anchor-ssh-auth-"));
    try {
      const privateKeyPath = path.join(tmp, "fixture_key");
      await fs.writeFile(privateKeyPath, "fixture-file-key");
      session = new SshHostSession({ ...base, privateKeyPath });
      await session.readFile("/file");
      expect(mocks.configs[0].privateKey).toBe("fixture-file-key");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("cancels pending verification on timeout and never revives the connection", async () => {
    vi.useFakeTimers();
    let finishVerification!: () => void;
    mocks.verify.mockImplementation(() => new Promise<void>((resolve) => { finishVerification = resolve; }));
    session = new SshHostSession({ ...base, readyTimeoutMs: 100 });
    const result = expect(session.readFile("/file")).rejects.toThrow("SSH connect timeout");
    await vi.advanceTimersByTimeAsync(100);
    await result;
    const options = mocks.verify.mock.calls[0][1] as { signal: AbortSignal };
    expect(options.signal.aborted).toBe(true);
    finishVerification();
    await vi.runAllTimersAsync();
    expect(mocks.readyCount).toBe(0);
  });
});
