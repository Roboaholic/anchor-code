// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { EDGE_HANDLE_HIT_MARGINS } from "./Shell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HERE = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(HERE, "../../styles/global.css"), "utf8")
  .replace(/\r\n/g, "\n")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  // Top-level rules only: drop @media blocks (e.g. the coarse-pointer sizes).
  .replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");

/** Last value of `prop` in a top-level rule whose selector list contains `selector`. */
function lastDecl(selector: string, prop: string): string | null {
  let found: string | null = null;
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = rule.exec(css); m; m = rule.exec(css)) {
    if (!m[1]!.split(",").map((s) => s.trim()).includes(selector)) continue;
    const d = new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`).exec(m[2]!);
    if (d) found = d[1]!.trim();
  }
  return found;
}
const px = (v: string | null) => parseFloat(v ?? "NaN");

// Sidebar edge at W = 200: line on x 200, handle box [196, 205), 14px gutter
// [186, 200) with the 6px thumb at [188, 194).
const W = 200;
const HANDLE = { left: W - 4, right: W + 5, top: 0, bottom: 600 };
const THUMB_CENTER = W - 9;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <PanelGroup direction="horizontal">
        <Panel defaultSize={30} id="l" order={1}>
          <div data-testid="scroller" style={{ overflow: "auto" }} />
        </Panel>
        <PanelResizeHandle data-testid="handle" hitAreaMargins={EDGE_HANDLE_HIT_MARGINS} />
        <Panel defaultSize={70} id="c" order={2} />
      </PanelGroup>,
    );
  });
  const handle = host.querySelector<HTMLElement>("[data-testid=handle]")!;
  handle.getBoundingClientRect = () =>
    ({ ...HANDLE, x: HANDLE.left, y: 0, width: 9, height: 600, toJSON() {} }) as DOMRect;
  const scroller = host.querySelector<HTMLElement>("[data-testid=scroller]")!;
  return { handle, scroller };
}

/** Dispatches on `target` — i.e. what the browser hit-tested at `clientX`. */
function press(target: HTMLElement, clientX: number) {
  const make = (type: string) => {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 300 });
    Object.defineProperty(ev, "isPrimary", { value: true });
    return ev;
  };
  const down = make("pointerdown");
  act(() => {
    target.dispatchEvent(down);
  });
  act(() => {
    target.dispatchEvent(make("pointerup"));
  });
  return down;
}

describe("edge resize handle geometry (CSS)", () => {
  it("is a 9px box centred on the 1px line with a 1px layout footprint", () => {
    expect(px(lastDecl(".resize-handle--edge", "width"))).toBe(9);
    expect(lastDecl(".resize-handle--edge", "margin")).toBe("0 -4px");
    expect(px(lastDecl(".resize-handle--edge::before", "left"))).toBe(4);
    expect(lastDecl(".resize-handle--edge", "position")).toBe("relative");
    expect(Number(lastDecl(".resize-handle--edge", "z-index"))).toBeGreaterThan(0);
  });

  it("keeps the sidebar thumb left of the handle's hit zone", () => {
    const gutter = px(lastDecl(".shell__left-panel ::-webkit-scrollbar:vertical", "width"));
    const rightBorder = px(
      lastDecl(".shell__left-panel ::-webkit-scrollbar-thumb:vertical", "border-right-width"),
    );
    const thumbRight = W - rightBorder; // thumb [W-gutter+2, W-rightBorder)
    expect(gutter - 2 - rightBorder).toBe(6); // still a 6px slim thumb
    expect(thumbRight).toBeLessThan(HANDLE.left);
    expect(THUMB_CENTER).toBe((W - gutter + 2 + thumbRight) / 2);
  });
});

describe("edge resize handle hit-testing", () => {
  it("resizes on a press 2px left of the line (lands on the handle box)", () => {
    const { handle } = mount();
    expect(press(handle, W - 2).defaultPrevented).toBe(true);
  });

  it("resizes on the line and 4px right of it", () => {
    const { handle } = mount();
    expect(press(handle, W).defaultPrevented).toBe(true);
    expect(press(handle, W + 4).defaultPrevented).toBe(true);
  });

  it("leaves a press on the thumb centre to the scrollbar", () => {
    const { scroller } = mount();
    expect(press(scroller, THUMB_CENTER).defaultPrevented).toBe(false);
    // Track pixel right next to the hit zone is not stolen either.
    expect(press(scroller, W - 5).defaultPrevented).toBe(false);
  });
});
