import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalHostSession } from "./localHost.js";
import { decodeBoundedBase64, readFilePrefix, readLocalFileBytes } from "./fileRead.js";

describe("bounded UTF-8 file previews", () => {
  let root: string;
  const host = new LocalHostSession("bounded-file-test");
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "anchor-preview-")); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it("returns only a complete UTF-8 prefix while unlimited reads retain the entire file", async () => {
    const file = path.join(root, "unicode.txt");
    await fs.writeFile(file, "abc中文🦊tail");
    for (const [maxBytes, expected] of [[0, ""], [3, "abc"], [4, "abc"], [5, "abc"], [6, "abc中"], [9, "abc中文"], [12, "abc中文"], [13, "abc中文🦊"]] as const) {
      expect(await host.readFile(file, { maxBytes })).toBe(expected);
    }
    expect(await host.readFile(file)).toBe("abc中文🦊tail");
    expect(await host.readFile(file, { maxBytes: 100 })).toBe("abc中文🦊tail");
    expect(await host.readFile(file, { maxBytes: 17 })).toBe("abc中文🦊tail");
  });

  it("reads at most the byte budget plus one even when the file is much larger or reads are short", async () => {
    const limit = 1024 * 1024;
    let totalRead = 0;
    const read = vi.fn(async (buffer: Buffer, _position: number, length: number) => {
      const count = Math.min(length, 317);
      buffer.fill(120, 0, count);
      totalRead += count;
      return count;
    });
    const text = await readFilePrefix(limit, read);
    expect(text).toBe("x".repeat(limit));
    expect(totalRead).toBe(limit + 1);
    expect(read.mock.calls.every(([, , length]) => length <= 64 * 1024)).toBe(true);
    expect(read.mock.calls.every(([buffer]) => buffer.length <= 64 * 1024)).toBe(true);
  });

  it("preserves missing-file errors and rejects invalid limits", async () => {
    await expect(host.readFile(path.join(root, "missing"), { maxBytes: 1 })).rejects.toMatchObject({ code: "not_found" });
    const file = path.join(root, "file");
    await fs.writeFile(file, "x");
    for (const maxBytes of [-1, 1.5, NaN, Infinity]) {
      await expect(host.readFile(file, { maxBytes })).rejects.toMatchObject({ code: "failed" });
    }
  });
});

describe("binary file reads", () => {
  let root: string;
  const host = new LocalHostSession("binary-file-test");
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "anchor-bytes-")); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it("returns every byte unchanged, including invalid UTF-8", async () => {
    const file = path.join(root, "图 片.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0xc3, 0x28]);
    await fs.writeFile(file, bytes);
    expect((await host.readFileBytes(file)).equals(bytes)).toBe(true);
  });

  it("rejects files above the byte budget and maps missing files", async () => {
    const file = path.join(root, "big.svg");
    await fs.writeFile(file, "x".repeat(2048));
    await expect(readLocalFileBytes(file, 1024)).rejects.toMatchObject({ code: "failed" });
    expect((await readLocalFileBytes(file, 2048)).length).toBe(2048);
    await expect(host.readFileBytes(path.join(root, "missing.svg"))).rejects.toMatchObject({ code: "not_found" });
    await expect(readLocalFileBytes(file, 21 * 1024 * 1024)).rejects.toMatchObject({ code: "failed" });
  });

  it("decodes line-wrapped base64 from remote shells and bounds it", () => {
    const bytes = Buffer.from(Array.from({ length: 300 }, (_, i) => i % 256));
    const wrapped = bytes.toString("base64").replace(/(.{76})/g, "$1\n") + "\n";
    expect(decodeBoundedBase64(wrapped, 300, "/x").equals(bytes)).toBe(true);
    expect(() => decodeBoundedBase64(wrapped, 299, "/x")).toThrow(/too large/);
  });
});

