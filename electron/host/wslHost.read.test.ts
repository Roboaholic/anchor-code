import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WslHostSession } from "./wslHost.js";
import { LocalHostSession } from "./localHost.js";

describe("bounded WSL reads", () => {
  let root: string;
  let host: WslHostSession;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "anchor-wsl-preview-"));
    host = new WslHostSession({ distro: "fixture" });
  });
  afterEach(async () => {
    await host.dispose();
    await fs.rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("bounds UNC reads using the same byte semantics as local previews", async () => {
    const file = path.join(root, "file");
    await fs.writeFile(file, "abc中文🦊tail");
    vi.spyOn(host as unknown as { toUnc(path: string): Promise<string> }, "toUnc").mockResolvedValue(file);
    const run = vi.spyOn(host, "run");
    expect(await host.readFile("/fixture/file", { maxBytes: 8 })).toBe("abc中");
    expect(await host.readFile("/fixture/file")).toBe("abc中文🦊tail");
    expect(run).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("bounds shell-fallback output and preserves errors without a live WSL host", async () => {
    const file = path.join(root, "file '中文");
    await fs.writeFile(file, "abc中文🦊" + "x".repeat(1024 * 1024));
    vi.spyOn(host as unknown as { toUnc(path: string): Promise<string> }, "toUnc")
      .mockRejectedValue(Object.assign(new Error("UNC symlink gap"), { code: "ENOENT" }));
    const local = new LocalHostSession();
    vi.spyOn(host, "run").mockImplementation((cwd, command, args, options) => local.run(cwd, command, args, options));
    expect(await host.readFile(file, { maxBytes: 8 })).toBe("abc中");
    expect(await host.readFile(file, { maxBytes: 13 })).toBe("abc中文🦊");
    await expect(host.readFile(`${root}/missing`, { maxBytes: 8 })).rejects.toMatchObject({ code: "not_found" });
  });

  it("reads image bytes through UNC without spawning WSL", async () => {
    const file = path.join(root, "a.svg");
    const bytes = Buffer.from([0x3c, 0x73, 0x76, 0x67, 0x00, 0xff]);
    await fs.writeFile(file, bytes);
    vi.spyOn(host as unknown as { toUnc(path: string): Promise<string> }, "toUnc").mockResolvedValue(file);
    const run = vi.spyOn(host, "run");
    expect((await host.readFileBytes("/home/u/a.svg")).equals(bytes)).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("falls back to base64 through bash for UNC gaps and keeps binary intact", async () => {
    const file = path.join(root, "图 '片.png");
    const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7) % 256));
    await fs.writeFile(file, bytes);
    vi.spyOn(host as unknown as { toUnc(path: string): Promise<string> }, "toUnc")
      .mockRejectedValue(Object.assign(new Error("UNC symlink gap"), { code: "ENOENT" }));
    const local = new LocalHostSession();
    vi.spyOn(host, "run").mockImplementation((cwd, command, args, options) => local.run(cwd, command, args, options));
    expect((await host.readFileBytes(file)).equals(bytes)).toBe(true);
    await expect(host.readFileBytes(file, 100)).rejects.toMatchObject({ code: "failed" });
    await expect(host.readFileBytes(`${root}/missing.svg`)).rejects.toMatchObject({ code: "not_found" });
  });
});

