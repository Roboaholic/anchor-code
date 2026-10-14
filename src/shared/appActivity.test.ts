// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { isAppActive, setActiveInterval } from "./appActivity";

function setState(visible: boolean, focused: boolean) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (visible ? "visible" : "hidden") });
  vi.spyOn(document, "hasFocus").mockReturnValue(focused);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("setActiveInterval", () => {
  it("skips ticks while hidden/unfocused and catches up once on focus", () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    setState(true, true);
    const stop = setActiveInterval(tick, 1000);
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(1);

    setState(true, false);
    expect(isAppActive()).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(tick).toHaveBeenCalledTimes(1);

    setState(true, true);
    window.dispatchEvent(new Event("focus"));
    expect(tick).toHaveBeenCalledTimes(2);
    // No double catch-up.
    window.dispatchEvent(new Event("focus"));
    expect(tick).toHaveBeenCalledTimes(2);

    stop();
    vi.advanceTimersByTime(5000);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("pauses while document hidden", () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    setState(false, true);
    const stop = setActiveInterval(tick, 500);
    vi.advanceTimersByTime(2000);
    expect(tick).not.toHaveBeenCalled();
    setState(true, true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(tick).toHaveBeenCalledTimes(1);
    stop();
  });
});
