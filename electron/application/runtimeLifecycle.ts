export interface RuntimeLifecycleApp {
  on(event: "before-quit" | "window-all-closed", listener: (event?: { preventDefault(): void }) => void): unknown;
}

export interface RuntimeLifecycleOptions {
  app: RuntimeLifecycleApp;
  platform: NodeJS.Platform;
  quit: () => void;
  dispose: () => void | Promise<void>;
  /** Finish queued state writes before allowing Electron to exit. */
  flush?: () => Promise<void>;
}

/** Make global runtime disposal idempotent across quit signals. */
export function onceDisposer(dispose: () => void | Promise<void>): () => void {
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    void dispose();
  };
}

/**
 * Closing the last window is not application shutdown on macOS. Global
 * services therefore dispose only from before-quit, while other platforms
 * still quit after their last window disappears.
 */
export function registerRuntimeLifecycle(options: RuntimeLifecycleOptions): () => void {
  const disposeOnce = onceDisposer(options.dispose);
  let flushing = false;
  let flushed = false;
  options.app.on("before-quit", (event) => {
    if (!options.flush || flushed) { disposeOnce(); return; }
    event?.preventDefault();
    if (flushing) return;
    flushing = true;
    void options.flush().catch((error: unknown) => {
      console.error("[runtime] failed to flush workspace state:", error);
    }).finally(() => {
      flushed = true;
      disposeOnce();
      options.quit();
    });
  });
  options.app.on("window-all-closed", () => {
    if (options.platform !== "darwin") options.quit();
  });
  return disposeOnce;
}
