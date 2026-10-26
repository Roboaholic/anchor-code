import { describe, expect, it } from "vitest";
import { imageMimeType } from "./imageMime.js";

describe("imageMimeType", () => {
  it("labels SVG as image/svg+xml so <img> data URLs render it", () => {
    expect(imageMimeType("/r/diagrams/detail-partial-stream.svg")).toBe("image/svg+xml");
    expect(imageMimeType("C:\\r\\图 1.SVG")).toBe("image/svg+xml");
  });

  it("maps common raster formats and rejects everything else", () => {
    expect(imageMimeType("a.png")).toBe("image/png");
    expect(imageMimeType("a.JPG")).toBe("image/jpeg");
    expect(imageMimeType("a.jpeg")).toBe("image/jpeg");
    expect(imageMimeType("a.gif")).toBe("image/gif");
    expect(imageMimeType("a.webp")).toBe("image/webp");
    expect(imageMimeType("a.html")).toBeNull();
    expect(imageMimeType("svg")).toBeNull();
    expect(imageMimeType(".svg")).toBeNull();
  });
});
