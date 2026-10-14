import { describe, expect, it } from "vitest";
import {
  parseSmoothScrollPref,
  smoothScrollingEffective,
  xtermSmoothScrollDuration,
} from "./smoothScrollStore";

describe("smooth scrolling setting", () => {
  it("defaults on unless explicitly off", () => {
    expect(parseSmoothScrollPref(null)).toBe(true);
    expect(parseSmoothScrollPref("on")).toBe(true);
    expect(parseSmoothScrollPref("off")).toBe(false);
  });
  it("reduced motion forces it off", () => {
    expect(smoothScrollingEffective(true, false)).toBe(true);
    expect(smoothScrollingEffective(true, true)).toBe(false);
    expect(smoothScrollingEffective(false, false)).toBe(false);
  });
  it("maps to xterm duration", () => {
    expect(xtermSmoothScrollDuration(true)).toBe(120);
    expect(xtermSmoothScrollDuration(false)).toBe(0);
  });
});
