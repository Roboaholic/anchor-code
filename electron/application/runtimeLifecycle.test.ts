import { describe, expect, it, vi } from "vitest";
import { registerRuntimeLifecycle, type RuntimeLifecycleApp } from "./runtimeLifecycle.js";

function fakeApp() {
  const listeners = new Map<string, () => void>();
  return {
    app: {
      on(event: "before-quit" | "window-all-closed", listener: () => void) {
        listeners.set(event, listener);
      },
    } satisfies RuntimeLifecycleApp,
    emit(event: "before-quit" | "window-all-closed") {
      listeners.get(event)?.();
    },
  };
}

describe("runtime lifecycle", () => {
  it("keeps global services alive when the last macOS window closes", () => {
    const source = fakeApp();
    const quit = vi.fn();
    const dispose = vi.fn();
    registerRuntimeLifecycle({ app: source.app, platform: "darwin", quit, dispose });

    source.emit("window-all-closed");
    expect(quit).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();

    source.emit("before-quit");
    source.emit("before-quit");
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("quits after the last window on non-macOS and disposes on quit", () => {
    const source = fakeApp();
    const quit = vi.fn();
    const dispose = vi.fn();
    registerRuntimeLifecycle({ app: source.app, platform: "linux", quit, dispose });

    source.emit("window-all-closed");
    expect(quit).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
    source.emit("before-quit");
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
