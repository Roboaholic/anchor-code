// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import {
  MAX_WHEEL_REPORTS_PER_EVENT,
  encodeWheelReport,
  mouseModeReportsWheel,
  nextMouseEncoding,
  wheelReportCount,
} from "./agentWheel";
import { installAgentWheelScrolling } from "./xtermSessionPool";

const PIXEL = 0;
const LINE = 1;

describe("wheelReportCount", () => {
  it("sends 3 reports per 100px notch (Windows default)", () => {
    const acc = { partial: 0 };
    expect(wheelReportCount({ deltaY: 100, deltaMode: PIXEL }, acc, 40)).toBe(3);
    expect(wheelReportCount({ deltaY: -100, deltaMode: PIXEL }, acc, 40)).toBe(-3);
  });

  it("follows the OS lines-per-notch setting via deltaY", () => {
    expect(wheelReportCount({ deltaY: 200, deltaMode: PIXEL }, { partial: 0 }, 40)).toBe(6);
  });

  it("accumulates small trackpad deltas and drops them on direction flip", () => {
    const acc = { partial: 0 };
    expect(wheelReportCount({ deltaY: 20, deltaMode: PIXEL }, acc, 40)).toBe(0);
    expect(wheelReportCount({ deltaY: 20, deltaMode: PIXEL }, acc, 40)).toBe(1);
    expect(wheelReportCount({ deltaY: -10, deltaMode: PIXEL }, acc, 40)).toBe(0);
    expect(acc.partial).toBeLessThan(0);
  });

  it("uses line deltas as-is and caps floods", () => {
    expect(wheelReportCount({ deltaY: 3, deltaMode: LINE }, { partial: 0 }, 40)).toBe(3);
    expect(wheelReportCount({ deltaY: 5000, deltaMode: PIXEL }, { partial: 0 }, 40)).toBe(
      MAX_WHEEL_REPORTS_PER_EVENT,
    );
  });
});

describe("mouse encoding", () => {
  it("tracks DECSET/DECRST like xterm", () => {
    expect(nextMouseEncoding("DEFAULT", [1000, 1002, 1003, 1015, 1006], true)).toBe("SGR");
    expect(nextMouseEncoding("SGR", [1006], false)).toBe("DEFAULT");
    expect(nextMouseEncoding("DEFAULT", [1016], true)).toBe("SGR_PIXELS");
    expect(nextMouseEncoding("SGR", [25], true)).toBe("SGR");
  });

  it("encodes wheel reports like xterm's CoreMouseService", () => {
    const pos = { col: 4, row: 9, x: 40, y: 150 };
    expect(encodeWheelReport("SGR", true, pos)).toBe("\x1b[<64;5;10M");
    expect(encodeWheelReport("SGR", false, pos)).toBe("\x1b[<65;5;10M");
    expect(encodeWheelReport("SGR_PIXELS", true, pos)).toBe("\x1b[<64;40;150M");
    expect(encodeWheelReport("DEFAULT", false, pos)).toBe(
      `\x1b[M${String.fromCharCode(97, 37, 42)}`,
    );
    expect(encodeWheelReport("DEFAULT", true, { col: 300, row: 0, x: 0, y: 0 })).toBe("");
  });

  it("only treats wheel-reporting modes as captured", () => {
    expect(mouseModeReportsWheel("none")).toBe(false);
    expect(mouseModeReportsWheel("x10")).toBe(false);
    expect(mouseModeReportsWheel("vt200")).toBe(true);
    expect(mouseModeReportsWheel("any")).toBe(true);
  });
});

describe("installAgentWheelScrolling", () => {
  function setup() {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    let handler: ((ev: WheelEvent) => boolean) | undefined;
    term.attachCustomWheelEventHandler = (h) => {
      handler = h;
    };
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    screen.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 800, height: 480, right: 800, bottom: 480 }) as DOMRect;
    const element = document.createElement("div");
    element.appendChild(screen);
    Object.defineProperty(term, "element", { get: () => element });
    const writes: string[] = [];
    installAgentWheelScrolling(term, (d) => writes.push(d));
    const write = (data: string) => new Promise<void>((r) => term.write(data, r));
    const wheel = (deltaY: number) =>
      handler!({
        deltaY,
        deltaMode: 0,
        clientX: 45,
        clientY: 105,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        metaKey: false,
      } as WheelEvent);
    return { term, writes, write, wheel };
  }

  it("leaves normal-buffer scrolling to xterm", async () => {
    const { writes, write, wheel } = setup();
    await write("\x1b[?1000h\x1b[?1006h");
    expect(wheel(100)).toBe(true);
    expect(writes).toEqual([]);
  });

  it("leaves alt-screen apps without mouse capture to xterm (arrow keys)", async () => {
    const { writes, write, wheel } = setup();
    await write("\x1b[?1049h");
    expect(wheel(100)).toBe(true);
    expect(writes).toEqual([]);
  });

  it("sends 3 SGR reports per notch for a Codex-style fullscreen TUI", async () => {
    const { writes, write, wheel } = setup();
    // crossterm EnableMouseCapture + alternate screen
    await write("\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1015h\x1b[?1006h");
    expect(wheel(-100)).toBe(false);
    expect(writes).toEqual(["\x1b[<64;5;6M".repeat(3)]);
  });

  it("returns to xterm's default once the app releases the mouse", async () => {
    const { writes, write, wheel } = setup();
    await write("\x1b[?1049h\x1b[?1000h\x1b[?1006h");
    await write("\x1b[?1000l");
    expect(wheel(100)).toBe(true);
    expect(writes).toEqual([]);
  });
});
