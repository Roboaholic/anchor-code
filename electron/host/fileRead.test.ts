import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalHostSession } from "./localHost.js";
import { readFilePrefix } from "./fileRead.js";

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
