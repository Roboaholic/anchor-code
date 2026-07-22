import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalHostSession } from "./localHost.js";
import { HostError } from "./types.js";

describe("LocalHostSession (integration)", () => {
  let tmp: string;
  let host: LocalHostSession;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "anchor-host-"));
    host = new LocalHostSession("test-host");
  });

  afterEach(async () => {
    await host.dispose();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("lists, reads, writes, stats, and mkdirp", async () => {
    await host.mkdirp(path.join(tmp, "nested", "dir"));
    await host.writeFile(path.join(tmp, "nested", "dir", "a.txt"), "hello\n");

    expect(await host.exists(path.join(tmp, "nested", "dir", "a.txt"))).toBe(
      true,
    );
    expect(await host.exists(path.join(tmp, "missing"))).toBe(false);

    const entries = await host.listDir(path.join(tmp, "nested"));
    expect(entries.some((e) => e.name === "dir" && e.type === "dir")).toBe(true);

    const text = await host.readFile(path.join(tmp, "nested", "dir", "a.txt"));
    expect(text).toBe("hello\n");

    const st = await host.stat(path.join(tmp, "nested", "dir", "a.txt"));
    expect(st.isFile).toBe(true);
    expect(st.size).toBeGreaterThan(0);
  });

  it("maps missing paths to HostError not_found", async () => {
    await expect(host.readFile(path.join(tmp, "nope.txt"))).rejects.toBeInstanceOf(
      HostError,
    );
    try {
      await host.readFile(path.join(tmp, "nope.txt"));
    } catch (err) {
      expect(err).toBeInstanceOf(HostError);
      expect((err as HostError).code).toBe("not_found");
    }
  });

  it("runs a simple command via run()", async () => {
    // Prefer a portable binary (shell builtins are not always spawnable).
    const r = await host.run(tmp, process.execPath, [
      "-e",
      "console.log('ok')",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("ok");
  });

  it(
    "openPty returns a writable handle",
    async () => {
      // Use process cwd / shared tmp so afterEach can rm the fixture dir.
      const pty = await host.openPty(os.tmpdir(), 80, 24);
      expect(pty.id).toBeTruthy();
      expect(typeof pty.write).toBe("function");
      expect(typeof pty.resize).toBe("function");
      pty.resize(100, 30);
      // Wait for real PTY I/O rather than a fixed sleep.
      const { promise, resolve } = Promise.withResolvers<void>();
      const timer = setTimeout(() => resolve(), 3_000);
      pty.onData(() => {
        clearTimeout(timer);
        resolve();
      });
      pty.write("\r");
      try {
        await promise;
      } finally {
        pty.kill();
      }
    },
    15_000,
  );
  it("exposes profileId from constructor", () => {
    const h = new LocalHostSession("id-1", "local-custom");
    expect(h.profileId).toBe("local-custom");
    expect(h.kind).toBe("local");
  });
});

