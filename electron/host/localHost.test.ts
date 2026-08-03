import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalHostSession } from "./localHost.js";
import { spawnLocalPty } from "./localPty.js";
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

  it("remove deletes a file and recursively a directory", async () => {
    const file = path.join(tmp, "gone.txt");
    const dir = path.join(tmp, "tree");
    await host.writeFile(file, "x");
    await host.mkdirp(path.join(dir, "sub"));
    await host.writeFile(path.join(dir, "sub", "deep.txt"), "y");

    await host.remove(file);
    expect(await host.exists(file)).toBe(false);

    await host.remove(dir);
    expect(await host.exists(dir)).toBe(false);
    expect(await host.exists(path.join(dir, "sub", "deep.txt"))).toBe(false);
  });

  it("remove on a missing path is not an error", async () => {
    // fs.rm force:true treats a missing path as success.
    await expect(host.remove(path.join(tmp, "never-existed"))).resolves.toBeUndefined();
  });

  it("rename moves a file and overwrites the destination", async () => {
    const src = path.join(tmp, "a.txt");
    const dst = path.join(tmp, "b.txt");
    await host.writeFile(src, "payload");
    await host.rename(src, dst);

    expect(await host.exists(src)).toBe(false);
    expect(await host.readFile(dst)).toBe("payload");
  });

  it("rename moves a directory tree", async () => {
    const src = path.join(tmp, "src");
    const dst = path.join(tmp, "dst");
    await host.mkdirp(path.join(src, "sub"));
    await host.writeFile(path.join(src, "sub", "f.txt"), "z");

    await host.rename(src, dst);
    expect(await host.exists(src)).toBe(false);
    expect(await host.readFile(path.join(dst, "sub", "f.txt"))).toBe("z");
  });

  it("copyPath duplicates a directory tree without removing the source", async () => {
    const src = path.join(tmp, "orig");
    const dst = path.join(tmp, "copy");
    await host.mkdirp(path.join(src, "sub"));
    await host.writeFile(path.join(src, "sub", "f.txt"), "data");

    await host.copyPath(src, dst);

    // Source is untouched.
    expect(await host.exists(src)).toBe(true);
    expect(await host.readFile(path.join(src, "sub", "f.txt"))).toBe("data");
    // Copy has the same contents.
    expect(await host.readFile(path.join(dst, "sub", "f.txt"))).toBe("data");
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

  it("supports earlyExit to stop a long-running process", async () => {
    // cwd outside fixture tmp so a slow Windows kill cannot EBUSY afterEach rm.
    const r = await host.run(os.tmpdir(), process.execPath, [
      "-e",
      // Print lines until killed
      "let i=0; setInterval(()=>{console.log('line:'+ (++i));}, 5);",
    ], {
      timeoutMs: 5_000,
      earlyExit: (stdout) => (stdout.match(/^line:/gm) ?? []).length >= 3,
    });
    expect(r.earlyExit).toBe(true);
    expect(r.code).toBe(0);
    expect((r.stdout.match(/^line:/gm) ?? []).length).toBeGreaterThanOrEqual(3);
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
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
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

  it(
    "replays output and exit emitted before listeners attach",
    async () => {
      if (process.platform === "win32") return;
      const { handle } = await spawnLocalPty(os.tmpdir(), 80, 24, {
        shell: "/bin/sh",
        args: ["-c", "printf 'anchor-early-frame'; exit 7"],
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      let output = "";
      let exitCode: number | null = null;
      handle.onData((data) => { output += data; });
      handle.onExit((code) => { exitCode = code; });

      expect(output).toContain("anchor-early-frame");
      expect(exitCode).toBe(7);
    },
    15_000,
  );
  it("exposes profileId from constructor", () => {
    const h = new LocalHostSession("id-1", "local-custom");
    expect(h.profileId).toBe("local-custom");
    expect(h.kind).toBe("local");
  });
});
