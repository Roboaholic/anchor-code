import { useEffect, useId, useState } from "react";
import mermaid from "mermaid";
import { isDarkTheme } from "@/core/theme/theme";
import { useThemeStore } from "@/features/shell/themeStore";
import { Icon } from "@/shared/Icon";

type Props = {
  /** Raw mermaid source (fence body). */
  chart: string;
  className?: string;
};

let mermaidConfiguredFor: "dark" | "light" | null = null;

function ensureMermaid(themeMode: "dark" | "light") {
  if (mermaidConfiguredFor !== themeMode) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: themeMode === "dark" ? "dark" : "default",
      fontFamily:
        "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
    });
    mermaidConfiguredFor = themeMode;
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
        ensureMermaid(themeMode);
        // Unique id per render — mermaid mutates/looks up by id.
        const id = `mermaid-${reactId}-${Math.random().toString(36).slice(2, 9)}`;
        const { svg: rendered } = await mermaid.render(id, source);
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
