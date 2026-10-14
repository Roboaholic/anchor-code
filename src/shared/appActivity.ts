/**
 * Window activity gate for background polls.
 *
 * Polls (file tree on WSL/SSH, annotation YAML, …) skip ticks while the window
 * is hidden or unfocused, and run once immediately when it becomes active
 * again so nothing is stale on return.
 */
export function isAppActive(): boolean {
  if (typeof document === "undefined") return true;
  if (document.visibilityState !== "visible") return false;
  return typeof document.hasFocus === "function" ? document.hasFocus() : true;
}

/** Call `cb` whenever the window becomes visible/focused again. Returns unsubscribe. */
export function onAppActive(cb: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onFocus = () => cb();
  const onVis = () => {
    if (document.visibilityState === "visible") cb();
  };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVis);
  return () => {
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVis);
  };
}

/**
 * setInterval that only fires while the app is active, plus one catch-up tick
 * on re-activation (if at least one tick was skipped).
 */
export function setActiveInterval(tick: () => void, ms: number): () => void {
  let skipped = false;
  const timer = window.setInterval(() => {
    if (!isAppActive()) {
      skipped = true;
      return;
    }
    skipped = false;
    tick();
  }, ms);
  const off = onAppActive(() => {
    if (!skipped) return;
    skipped = false;
    tick();
  });
  return () => {
    window.clearInterval(timer);
    off();
  };
}
