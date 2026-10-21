import { useEffect, useId, useState } from "react";
import { isDarkTheme } from "@/core/theme/theme";
import { useThemeStore } from "@/features/shell/themeStore";
import { Icon } from "@/shared/Icon";

type Props = {
  /** Raw mermaid source (fence body). */
  chart: string;
  className?: string;
};

let mermaidConfiguredFor: "dark" | "light" | null = null;
type MermaidApi = typeof import("mermaid").default;
let mermaidPromise: Promise<MermaidApi> | null = null;

/** Font stack mermaid both measures with and renders with (set on the SVG root). */
export const MERMAID_FONT_FAMILY =
  "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";

/** Max label width (px) before mermaid wraps an HTML label onto more lines. */
export const MERMAID_WRAPPING_WIDTH = 200;

/** Lazy-load mermaid (~MBs incl. diagram chunks) only when a diagram is rendered. */
function loadMermaid(): Promise<MermaidApi> {
  mermaidPromise ??= import("mermaid").then((m) => m.default);
  return mermaidPromise;
}

async function ensureMermaid(themeMode: "dark" | "light"): Promise<MermaidApi> {
  const mermaid = await loadMermaid();
  if (mermaidConfiguredFor !== themeMode) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: themeMode === "dark" ? "dark" : "default",
      fontFamily: MERMAID_FONT_FAMILY,
      themeVariables: { fontFamily: MERMAID_FONT_FAMILY },
      flowchart: { htmlLabels: true, wrappingWidth: MERMAID_WRAPPING_WIDTH },
    });
    mermaidConfiguredFor = themeMode;
  }
  return mermaid;
}

/**
 * Mermaid decides whether an HTML label must wrap with an exact float check:
 * it lays the label out with `white-space: nowrap; max-width: Wpx` and only
 * switches to wrapping when `getBoundingClientRect().width === W`. Under a
 * fractional effective zoom (Windows display scaling × the workbench UI
 * scale, e.g. 150% × 110%) Chromium reports 199.99998 or 200.00002 instead of
 * 200, the check fails, the label stays on one line clamped to W and the
 * foreignObject clips the rest ("当前连接、可用视频轨道、连…").
 *
 * While mermaid renders, snap such sub-pixel near-misses back to W — only for
 * elements inside mermaid's temporary render container that carry an inline
 * px max-width (i.e. exactly the label divs mermaid is measuring).
 */
const SNAP_EPSILON_PX = 0.05;
let gbcrPatchDepth = 0;
let originalGbcr: typeof Element.prototype.getBoundingClientRect | null = null;

export function snapMermaidLabelRect(el: Element, rect: DOMRect): DOMRect {
  if (!(el instanceof HTMLElement)) return rect;
  const maxWidth = el.style.maxWidth;
  if (!maxWidth.endsWith("px")) return rect;
  const target = Number.parseFloat(maxWidth);
  if (!Number.isFinite(target) || rect.width === target) return rect;
  if (Math.abs(rect.width - target) >= SNAP_EPSILON_PX) return rect;
  if (!el.closest('[id^="dmermaid-"]')) return rect;
  return new DOMRect(rect.x, rect.y, target, rect.height);
}

function patchLabelMeasurement(): () => void {
  if (gbcrPatchDepth === 0) {
    const original = Element.prototype.getBoundingClientRect;
    originalGbcr = original;
    Element.prototype.getBoundingClientRect = function patchedGbcr(this: Element) {
      return snapMermaidLabelRect(this, original.call(this));
    };
  }
  gbcrPatchDepth += 1;
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    gbcrPatchDepth -= 1;
    if (gbcrPatchDepth === 0 && originalGbcr) {
      Element.prototype.getBoundingClientRect = originalGbcr;
      originalGbcr = null;
    }
  };
}

/** Render with fonts settled and label measurement snapped (see above). */
async function renderMermaid(
  mermaid: MermaidApi,
  id: string,
  source: string,
): Promise<string> {
  // Measure with the same (loaded) fonts the SVG will paint with.
  try {
    await document.fonts?.ready;
  } catch {
    // ignore — measurement falls back to whatever is available
  }
  const restore = patchLabelMeasurement();
  try {
    const { svg } = await mermaid.render(id, source);
    return svg;
  } finally {
    restore();
  }
}

/**
 * Renders a ```mermaid fenced block as an SVG diagram.
 * Falls back to a preformatted error + source when parse/render fails.
 * Click the diagram to open a lightbox for enlarged browsing.
 */
export function MermaidBlock({ chart, className }: Props) {
  const theme = useThemeStore((s) => s.theme);
  const themeMode = isDarkTheme(theme) ? "dark" : "light";
  const reactId = useId().replace(/:/g, "");
  const [error, setError] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const source = chart.trim();
    if (!source) {
      setSvg(null);
      setError("Empty mermaid diagram");
      return;
    }

    void (async () => {
      try {
        const mermaid = await ensureMermaid(themeMode);
        // Unique id per render — mermaid mutates/looks up by id.
        const id = `mermaid-${reactId}-${Math.random().toString(36).slice(2, 9)}`;
        const rendered = await renderMermaid(mermaid, id, source);
        if (cancelled) return;
        setError(null);
        setSvg(rendered);
      } catch (err) {
        if (cancelled) return;
        setSvg(null);
        setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [chart, themeMode, reactId]);

  useEffect(() => {
    if (!lightboxOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setLightboxOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [lightboxOpen]);

  return (
    <>
      <div className={className ?? "md-mermaid"} data-mermaid="true">
        {error ? (
          <div className="md-mermaid__error" role="alert">
            <div className="md-mermaid__error-title">Mermaid render failed</div>
            <pre className="md-mermaid__error-msg">{error}</pre>
            <pre className="md-mermaid__source">
              <code>{chart}</code>
            </pre>
          </div>
        ) : svg ? (
          <div
            className="md-mermaid__svg md-mermaid__svg--zoomable"
            role="button"
            tabIndex={0}
            title="Click to enlarge"
            aria-label="Enlarge mermaid diagram"
            onClick={() => setLightboxOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setLightboxOpen(true);
              }
            }}
            // mermaid returns SVG markup from its renderer
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <div className="md-mermaid__loading muted">Rendering diagram…</div>
        )}
      </div>

      {lightboxOpen && svg ? (
        <div
          className="md-mermaid-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="Mermaid diagram preview"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setLightboxOpen(false);
          }}
        >
          <div className="md-mermaid-lightbox__panel">
            <header className="md-mermaid-lightbox__header">
              <span className="md-mermaid-lightbox__title">Mermaid</span>
              <button
                type="button"
                className="icon-btn"
                title="Close"
                aria-label="Close diagram preview"
                onClick={() => setLightboxOpen(false)}
              >
                <Icon name="close" />
              </button>
            </header>
            <div
              className="md-mermaid-lightbox__body"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

/** True when a react-markdown code node is a mermaid fence. */
export function isMermaidLanguage(
  className?: string,
  language?: string,
): boolean {
  if (language && language.toLowerCase() === "mermaid") return true;
  if (!className) return false;
  return /(^|\s)language-mermaid(\s|$)/i.test(className);
}
