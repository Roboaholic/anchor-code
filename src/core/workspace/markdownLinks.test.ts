import { describe, expect, it } from "vitest";
import {
  imageDataUrl,
  isPreviewableImagePath,
  isRasterImagePath,
  isSvgPath,
  normalizeHostPath,
  resolveMarkdownTarget,
} from "./markdownLinks";

describe("resolveMarkdownTarget", () => {
  it("resolves relative image/link paths against the Markdown file's folder (WSL / SSH posix)", () => {
    expect(resolveMarkdownTarget("/home/u/proj/docs/design.md", "diagrams/detail-partial-stream.svg"))
      .toEqual({ kind: "file", path: "/home/u/proj/docs/diagrams/detail-partial-stream.svg", fragment: "" });
    expect(resolveMarkdownTarget("/home/u/proj/docs/design.md", "./a/../b/./c.png"))
      .toEqual({ kind: "file", path: "/home/u/proj/docs/b/c.png", fragment: "" });
    expect(resolveMarkdownTarget("/home/u/proj/docs/design.md", "../../../../../../etc/x.svg"))
      .toEqual({ kind: "file", path: "/etc/x.svg", fragment: "" });
  });

  it("handles Windows local paths and backslash separators", () => {
    expect(resolveMarkdownTarget("C:\\Users\\me\\proj\\README.md", "diagrams\\flow.svg"))
      .toMatchObject({ kind: "file", path: "C:/Users/me/proj/diagrams/flow.svg" });
    expect(resolveMarkdownTarget("C:/Users/me/proj/docs/README.md", "../img/a.png"))
      .toMatchObject({ kind: "file", path: "C:/Users/me/proj/img/a.png" });
    expect(resolveMarkdownTarget("C:/proj/README.md", "D:\\other\\a.png"))
      .toMatchObject({ kind: "file", path: "D:/other/a.png" });
    expect(resolveMarkdownTarget("//wsl$/Ubuntu/home/u/README.md", "img/a.png"))
      .toMatchObject({ kind: "file", path: "//wsl$/Ubuntu/home/u/img/a.png" });
  });

  it("decodes percent-encoding, keeps raw non-ASCII and spaces, and strips query/fragment", () => {
    expect(resolveMarkdownTarget("/r/doc.md", "my%20diagrams/%E7%BB%93%E6%9E%84.svg?v=2#top"))
      .toEqual({ kind: "file", path: "/r/my diagrams/结构.svg", fragment: "top" });
    expect(resolveMarkdownTarget("/r/文档/doc.md", "图 1.svg"))
      .toEqual({ kind: "file", path: "/r/文档/图 1.svg", fragment: "" });
    // A literal % that is not an escape must not throw.
    expect(resolveMarkdownTarget("/r/doc.md", "100%.svg")).toMatchObject({ path: "/r/100%.svg" });
    expect(resolveMarkdownTarget("/r/doc.md", "other.md#L12")).toEqual({ kind: "file", path: "/r/other.md", fragment: "L12" });
  });

  it("classifies anchors, web links, file URLs and dangerous schemes", () => {
    expect(resolveMarkdownTarget("/r/doc.md", "#6.2-同-session")).toEqual({ kind: "anchor", fragment: "6.2-同-session" });
    expect(resolveMarkdownTarget("/r/doc.md", "https://example.com/a b")).toEqual({ kind: "external", url: "https://example.com/a%20b" });
    expect(resolveMarkdownTarget("/r/doc.md", "mailto:a@b.c")).toMatchObject({ kind: "external" });
    expect(resolveMarkdownTarget("/r/doc.md", "//cdn.example.com/x.png")).toEqual({ kind: "external", url: "https://cdn.example.com/x.png" });
    expect(resolveMarkdownTarget("/r/doc.md", "file:///C:/proj/a%20b.svg")).toMatchObject({ kind: "file", path: "C:/proj/a b.svg" });
    expect(resolveMarkdownTarget("/r/doc.md", "file:///home/u/x.svg")).toMatchObject({ kind: "file", path: "/home/u/x.svg" });
    expect(resolveMarkdownTarget("/r/doc.md", "javascript:alert(1)")).toEqual({ kind: "blocked" });
    expect(resolveMarkdownTarget("/r/doc.md", "data:text/html,<b>x</b>")).toEqual({ kind: "blocked" });
    expect(resolveMarkdownTarget("/r/doc.md", "")).toEqual({ kind: "blocked" });
    expect(resolveMarkdownTarget("/r/doc.md", undefined)).toEqual({ kind: "blocked" });
  });
});

describe("image path helpers", () => {
  it("recognises previewable formats including SVG", () => {
    for (const p of ["a.png", "a.JPG", "a.jpeg", "a.gif", "a.webp", "dir/a.svg", "C:\\x\\A.SVG", "a.avif"]) {
      expect(isPreviewableImagePath(p)).toBe(true);
    }
    expect(isPreviewableImagePath("a.md")).toBe(false);
    expect(isPreviewableImagePath(".svg")).toBe(false);
    expect(isSvgPath("x/flow.Svg")).toBe(true);
    expect(isRasterImagePath("x/flow.svg")).toBe(false);
    expect(isRasterImagePath("x/flow.png")).toBe(true);
  });

  it("builds data URLs with the given MIME type", () => {
    expect(imageDataUrl("image/svg+xml", "PHN2Zy8+")).toBe("data:image/svg+xml;base64,PHN2Zy8+");
  });

  it("normalizes without escaping the root", () => {
    expect(normalizeHostPath("/a/../../b")).toBe("/b");
    expect(normalizeHostPath("C:/a/../..")).toBe("C:/");
    expect(normalizeHostPath("a//b/./c")).toBe("a/b/c");
  });
});
