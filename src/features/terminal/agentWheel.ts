/**
 * Wheel scrolling for agent TUIs that capture the mouse (Codex fullscreen).
 *
 * xterm.js reports exactly ONE wheel event to the app per DOM `wheel` event
 * (CoreBrowserTerminal.bindMouse → sendEvent → triggerMouseEvent; the line
 * count from consumeWheelEvent only gates zero). Chromium fires one `wheel`
 * event per notch, so an app that maps one report to one row — Codex ≥ 0.162
 * with the default `tui.mouse_scroll_speed = 1` — moves 1 row per notch,
 * while xterm's own scrollback (Claude / Gemini inline sessions) moves
 * ~100px / cell height ≈ 5 rows per notch.
 *
 * For Agent sessions in the alternate buffer with mouse tracking on, we send
 * the wheel reports ourselves: WHEEL_ROWS_PER_NOTCH reports per 100px of
 * wheel delta (Windows' "3 lines per notch" default), accumulated so trackpad
 * pixel deltas still produce smooth single steps.
 */

export type MouseEncoding = "DEFAULT" | "SGR" | "SGR_PIXELS";

export type MouseTrackingMode = "none" | "x10" | "vt200" | "drag" | "any";

/** Reports sent per 100px (one Windows/Chromium notch) of wheel delta. */
export const WHEEL_ROWS_PER_NOTCH = 3;
const PIXELS_PER_NOTCH = 100;
/** Upper bound per DOM event so a fast fling can't flood the PTY. */
export const MAX_WHEEL_REPORTS_PER_EVENT = 30;

/** Apply DECSET/DECRST params to the tracked mouse encoding (mirrors xterm). */
export function nextMouseEncoding(
  current: MouseEncoding,
  params: readonly (number | number[])[],
  set: boolean,
): MouseEncoding {
  let encoding = current;
  for (const raw of params) {
    const p = Array.isArray(raw) ? raw[0] : raw;
    if (p === 1006) encoding = set ? "SGR" : "DEFAULT";
    else if (p === 1016) encoding = set ? "SGR_PIXELS" : "DEFAULT";
  }
  return encoding;
}

/** True when the app asked for wheel reports (xterm: VT200, DRAG, ANY). */
export function mouseModeReportsWheel(mode: MouseTrackingMode): boolean {
  return mode === "vt200" || mode === "drag" || mode === "any";
}

export type WheelAccumulator = { partial: number };

/**
 * Convert one WheelEvent into a signed report count (negative = up).
 * Fractions carry over in `acc` so small trackpad deltas add up.
 */
export function wheelReportCount(
  ev: { deltaY: number; deltaMode: number },
  acc: WheelAccumulator,
  rows: number,
): number {
  if (ev.deltaY === 0) return 0;
  let amount: number;
  if (ev.deltaMode === 1 /* DOM_DELTA_LINE */) {
    amount = ev.deltaY;
  } else if (ev.deltaMode === 2 /* DOM_DELTA_PAGE */) {
    amount = ev.deltaY * Math.max(1, rows);
  } else {
    amount = (ev.deltaY / PIXELS_PER_NOTCH) * WHEEL_ROWS_PER_NOTCH;
  }
  // Direction flip drops the carried fraction.
  if (acc.partial !== 0 && Math.sign(acc.partial) !== Math.sign(amount)) acc.partial = 0;
  acc.partial += amount;
  const whole = Math.trunc(acc.partial) || 0;
  acc.partial -= whole;
  return Math.max(-MAX_WHEEL_REPORTS_PER_EVENT, Math.min(MAX_WHEEL_REPORTS_PER_EVENT, whole));
}

/**
 * Encode one wheel report exactly like xterm's CoreMouseService.
 * col/row are 0-based cells (reported 1-based), x/y 0-based CSS pixels
 * (reported as-is, like xterm's SGR_PIXELS encoder).
 */
export function encodeWheelReport(
  encoding: MouseEncoding,
  up: boolean,
  pos: { col: number; row: number; x: number; y: number },
): string {
  const code = 64 | (up ? 0 : 1);
  if (encoding === "SGR") return `\x1b[<${code};${pos.col + 1};${pos.row + 1}M`;
  if (encoding === "SGR_PIXELS") return `\x1b[<${code};${pos.x};${pos.y}M`;
  const params = [code + 32, pos.col + 1 + 32, pos.row + 1 + 32];
  if (params.some((v) => v > 255)) return "";
  return `\x1b[M${String.fromCharCode(...params)}`;
}
