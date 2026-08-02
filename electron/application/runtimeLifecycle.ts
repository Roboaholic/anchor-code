export interface RuntimeLifecycleApp {
  on(event: "before-quit" | "window-all-closed", listener: () => void): unknown;
}

export interface RuntimeLifecycleOptions {
  app: RuntimeLifecycleApp;
  platform: NodeJS.Platform;
  quit: () => void;
  dispose: () => void | Promise<void>;
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
  options.app.on("before-quit", disposeOnce);
  options.app.on("window-all-closed", () => {
    if (options.platform !== "darwin") options.quit();
  });
  return disposeOnce;
}
