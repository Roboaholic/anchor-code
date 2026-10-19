import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalHostSession } from "../host/localHost.js";
import { searchWorkspaceContent } from "./contentSearch.js";
import { resolveLocalRgPath } from "./rgPath.js";

describe("searchWorkspaceContent (integration)", () => {
  let tmp: string;
  let host: LocalHostSession;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "anchor-search-"));
    host = new LocalHostSession("search-test");
    await fs.writeFile(path.join(tmp, "hello.ts"), "const uniqueNeedleXYZ = 1;\nconst other = 2;\n", "utf8");
    await fs.writeFile(path.join(tmp, "skip.bin"), Buffer.from([0, 1, 2, 3]));
  });

  afterEach(async () => {
    await host.dispose();
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it("uses bundled rg when available", async () => {
    const rg = resolveLocalRgPath();
    expect(rg, "bundled rg should be installed").toBeTruthy();
    const result = await searchWorkspaceContent(host, tmp, "uniqueNeedleXYZ", {
      maxResults: 20,
      caseSensitive: true,
    });
    expect(result.source).toBe("rg");
    expect(result.hits.length).toBeGreaterThanOrEqual(1);
    expect(result.hits[0]?.path).toMatch(/hello\.ts$/);
    expect(result.hits[0]?.text).toContain("uniqueNeedleXYZ");
  });

  it("reports the large-file limit when a synthetic C file is skipped", async () => {
    await fs.writeFile(path.join(tmp, "large.c"), "// fixture\nlargeFileNeedle\n" + " ".repeat(512 * 1024));
    const result = await searchWorkspaceContent(host, tmp, "largeFileNeedle");
    expect(result).toMatchObject({ source: "rg", status: "complete", hits: [] });
    expect(result.diagnostics?.find((d) => d.code === "rg-scope")?.message).toContain("512 KiB");
  });

  it.skipIf(process.platform === "win32")("discloses that symbolic-link directories are not followed", async () => {
    await fs.mkdir(path.join(tmp, "real"));
    await fs.writeFile(path.join(tmp, "real", "target.c"), "symlinkNeedle\n");
    await fs.symlink(path.join(tmp, "real"), path.join(tmp, "alias"), "dir");
    const result = await searchWorkspaceContent(host, tmp, "symlinkNeedle", { exclude: ["real"] });
    expect(result.hits).toEqual([]);
    expect(result.diagnostics?.find((d) => d.code === "rg-scope")?.message).toContain("symbolic links are not followed");
  });

  it("discloses the per-file hit cap without advertising more result pages", async () => {
    await fs.writeFile(path.join(tmp, "many.c"), "perFileNeedle\n".repeat(12));
    const result = await searchWorkspaceContent(host, tmp, "perFileNeedle");
    expect(result.hits).toHaveLength(8);
    expect(result.truncated).toBe(false);
    expect(result.diagnostics?.find((d) => d.code === "rg-scope")?.message).toContain("8 matching lines per file");
  });

});
