import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostManager } from "../host/hostManager.js";
import { LocalHostSession } from "../host/localHost.js";
import type { WorkspaceFacade } from "./workspaceFacade.js";
import { ReviewFacade } from "./reviewFacade.js";

describe("ReviewFacade file previews", () => {
  let root: string;
  let host: LocalHostSession;
  let review: ReviewFacade;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "anchor-review-file-"));
    host = new LocalHostSession();
    const workspace = { safePath: (input: string) => path.join(root, input) } as WorkspaceFacade;
    review = new ReviewFacade(new HostManager(host), workspace);
  });
  afterEach(async () => { await host.dispose(); await fs.rm(root, { recursive: true, force: true }); });

  it("limits host reads before allocating a large preview, retaining actual byte size", async () => {
    const limit = 1024 * 1024;
    const file = path.join(root, "large.log");
    const contents = "x".repeat(limit - 1) + "中" + "y".repeat(limit);
    await fs.writeFile(file, contents);
    const read = vi.spyOn(host, "readFile");
    const preview = await review.readFile("large.log");
    expect(read).toHaveBeenCalledWith(file, { maxBytes: limit });
    expect(preview).toEqual({ path: file, text: "x".repeat(limit - 1), size: Buffer.byteLength(contents), truncated: true });
  });

  it("preserves complete small files and refuses directories before reading", async () => {
    await fs.writeFile(path.join(root, "small.txt"), "中文🦊");
    expect(await review.readFile("small.txt")).toMatchObject({ text: "中文🦊", size: 10, truncated: false });
    const read = vi.spyOn(host, "readFile");
    await expect(review.readFile(".")).rejects.toMatchObject({ code: "failed" });
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps an in-flight preview on its original host when the workspace switches", async () => {
    let finishStat!: (value: { isFile: boolean; isDir: boolean; size: number; mtimeMs: number }) => void;
    const originalRead = vi.fn().mockResolvedValue("original");
    const replacementRead = vi.fn().mockResolvedValue("replacement");
    const hosts = {
      session: {
        stat: vi.fn(() => new Promise((resolve) => { finishStat = resolve; })),
        readFile: originalRead,
      },
    };
    const workspace = { safePath: (input: string) => input } as WorkspaceFacade;
    const facade = new ReviewFacade(hosts as unknown as HostManager, workspace);
    const pending = facade.readFile("/file");
    hosts.session = { stat: vi.fn(), readFile: replacementRead };
    finishStat({ isFile: true, isDir: false, size: 8, mtimeMs: 0 });
    expect(await pending).toMatchObject({ text: "original" });
    expect(originalRead).toHaveBeenCalledOnce();
    expect(replacementRead).not.toHaveBeenCalled();
  });

  it("serves workspace images as bytes with an image MIME type, SVG included", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>alert(1)</script></svg>';
    await fs.mkdir(path.join(root, "diagrams"));
    await fs.writeFile(path.join(root, "diagrams", "结构 图.svg"), svg);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    await fs.writeFile(path.join(root, "a.png"), png);
    const readBytes = vi.spyOn(host, "readFileBytes");
    const image = await review.readImage("diagrams/结构 图.svg");
    expect(image).toMatchObject({ mime: "image/svg+xml", size: Buffer.byteLength(svg) });
    expect(Buffer.from(image.base64, "base64").toString("utf8")).toBe(svg);
    expect(readBytes).toHaveBeenCalledWith(path.join(root, "diagrams", "结构 图.svg"), 20 * 1024 * 1024);
    const raster = await review.readImage("a.png");
    expect(raster.mime).toBe("image/png");
    expect(Buffer.from(raster.base64, "base64").equals(png)).toBe(true);
  });

  it("refuses non-image files without reading them", async () => {
    await fs.writeFile(path.join(root, "notes.txt"), "secret");
    const readBytes = vi.spyOn(host, "readFileBytes");
    await expect(review.readImage("notes.txt")).rejects.toMatchObject({ code: "failed" });
    expect(readBytes).not.toHaveBeenCalled();
  });
});
