import { describe, expect, it, vi } from "vitest";
import { registerRuntimeLifecycle, type RuntimeLifecycleApp } from "./runtimeLifecycle.js";

function fakeApp() {
  const listeners = new Map<string, (event?: { preventDefault(): void }) => void>();
  return {
    app: {
      on(event: "before-quit" | "window-all-closed", listener: (event?: { preventDefault(): void }) => void) {
        listeners.set(event, listener);
      },
    } satisfies RuntimeLifecycleApp,
    emit(event: "before-quit" | "window-all-closed", payload?: { preventDefault(): void }) {
      listeners.get(event)?.(payload);
    },
  };
}

describe("runtime lifecycle", () => {
  it("waits for pending state writes and only requests quit once", async () => {
    const source = fakeApp();
    let finish!: () => void;
    const flush = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const quit = vi.fn();
    const dispose = vi.fn();
    const preventDefault = vi.fn();
    registerRuntimeLifecycle({ app: source.app, platform: "linux", quit, dispose, flush });
    source.emit("before-quit", { preventDefault });
    source.emit("before-quit", { preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
    source.emit("before-quit", { preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
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
