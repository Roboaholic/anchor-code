// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { snapMermaidLabelRect } from "./MermaidBlock";

function label(inRenderContainer: boolean, maxWidth = "200px"): HTMLElement {
  const host = document.createElement("div");
  if (inRenderContainer) host.id = "dmermaid-abc123";
  const div = document.createElement("div");
  div.style.whiteSpace = "nowrap";
  div.style.maxWidth = maxWidth;
  host.appendChild(div);
  document.body.appendChild(host);
  return div;
}

describe("snapMermaidLabelRect", () => {
  it("snaps sub-pixel near-misses of the wrap width (fractional zoom)", () => {
    for (const w of [199.99998474121, 200.00001525879, 199.98843383789]) {
      const r = snapMermaidLabelRect(label(true), new DOMRect(3, 4, w, 24));
      expect(r.width).toBe(200);
      expect(r.x).toBe(3);
      expect(r.height).toBe(24);
    }
  });

  it("leaves genuinely narrower labels alone", () => {
    const r = snapMermaidLabelRect(label(true), new DOMRect(0, 0, 173.6, 24));
    expect(r.width).toBe(173.6);
  });

  it("only touches labels inside mermaid's render container", () => {
    const r = snapMermaidLabelRect(label(false), new DOMRect(0, 0, 199.99998, 24));
    expect(r.width).toBe(199.99998);
  });

  it("ignores elements without a px max-width", () => {
    const r = snapMermaidLabelRect(label(true, ""), new DOMRect(0, 0, 199.99998, 24));
    expect(r.width).toBe(199.99998);
  });
});
