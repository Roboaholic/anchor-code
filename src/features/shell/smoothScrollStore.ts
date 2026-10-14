import { create } from "zustand";

/** Smooth-scrolling preference (renderer-local), default ON. */
export const SMOOTH_SCROLL_STORAGE_KEY = "anchor.smoothScrolling";
/** xterm wheel/scrollbar animation; output-driven scrolling is never animated. */
export const XTERM_SMOOTH_SCROLL_MS = 120;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export function parseSmoothScrollPref(raw: string | null | undefined): boolean {
  return raw !== "off";
}

/** prefers-reduced-motion always wins (auto off). */
export function smoothScrollingEffective(enabled: boolean, reducedMotion: boolean): boolean {
  return enabled && !reducedMotion;
}

function readPref(): boolean {
  try {
    return parseSmoothScrollPref(localStorage.getItem(SMOOTH_SCROLL_STORAGE_KEY));
  } catch {
    return true;
  }
}

function readReducedMotion(): boolean {
  try {
    return window.matchMedia?.(REDUCED_MOTION_QUERY).matches ?? false;
  } catch {
    return false;
  }
}

function applyRootClass(on: boolean): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("smooth-scroll", on);
}

type SmoothScrollState = {
  enabled: boolean;
  reducedMotion: boolean;
  /** enabled && !reducedMotion */
  effective: boolean;
  setEnabled: (enabled: boolean) => void;
  setReducedMotion: (reduced: boolean) => void;
};

export const useSmoothScrollStore = create<SmoothScrollState>((set, get) => {
  const enabled = readPref();
  const reducedMotion = readReducedMotion();
  const effective = smoothScrollingEffective(enabled, reducedMotion);
  applyRootClass(effective);
  return {
    enabled,
    reducedMotion,
    effective,
    setEnabled: (next) => {
      try {
        localStorage.setItem(SMOOTH_SCROLL_STORAGE_KEY, next ? "on" : "off");
      } catch {
        // ignore
      }
      const eff = smoothScrollingEffective(next, get().reducedMotion);
      applyRootClass(eff);
      set({ enabled: next, effective: eff });
    },
    setReducedMotion: (reduced) => {
      const eff = smoothScrollingEffective(get().enabled, reduced);
      applyRootClass(eff);
      set({ reducedMotion: reduced, effective: eff });
    },
  };
});

try {
  const mq = window.matchMedia?.(REDUCED_MOTION_QUERY);
  mq?.addEventListener?.("change", (e) =>
    useSmoothScrollStore.getState().setReducedMotion(e.matches),
  );
} catch {
  // non-browser env
}

export function xtermSmoothScrollDuration(effective: boolean): number {
  return effective ? XTERM_SMOOTH_SCROLL_MS : 0;
}
