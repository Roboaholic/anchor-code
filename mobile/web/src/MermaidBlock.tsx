import { useEffect, useId, useRef, useState } from "react";
import mermaid from "mermaid";

let initialized = false;
let renderQueue = Promise.resolve();

function initializeMermaid() {
  if (initialized) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: "dark",
    themeVariables: {
      background: "#0d1218",
      primaryColor: "#182219",
      primaryTextColor: "#e7edf3",
      primaryBorderColor: "#657839",
      lineColor: "#aeb9c6",
      secondaryColor: "#152130",
      tertiaryColor: "#202733",
      fontFamily: 'Inter, system-ui, sans-serif',
    },
  });
  initialized = true;
}

function queuedRender(id: string, chart: string) {
  const result = renderQueue.then(() => mermaid.render(id, chart));
  renderQueue = result.then(() => undefined, () => undefined);
  return result;
}

export function MermaidBlock({ chart }: { chart: string }) {
  const reactId = useId();
  const hostRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [svg, setSvg] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || visible) return;
    if (!("IntersectionObserver" in window)) {
      setVisible(true);
      return;
    }
    try {
      const observer = new IntersectionObserver(([entry]) => {
        if (!entry?.isIntersecting) return;
        setVisible(true);
        observer.disconnect();
      }, { rootMargin: "240px 0px" });
      observer.observe(host);
      return () => observer.disconnect();
    } catch {
      setVisible(true);
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const renderId = `anchor-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
    setSvg("");
    setError(null);
    try {
      initializeMermaid();
      void queuedRender(renderId, chart).then((result) => {
        if (!cancelled) setSvg(result.svg);
      }).catch((renderError) => {
        if (!cancelled) setError(renderError instanceof Error ? renderError.message : "Mermaid 图表语法错误");
      });
    } catch (renderError) {
      setError(renderError instanceof Error ? renderError.message : "当前 WebView 无法初始化 Mermaid");
    }
    return () => { cancelled = true; };
  }, [chart, reactId, visible]);

  if (error) {
    return <div ref={hostRef} className="mermaid-error"><b>Mermaid 渲染失败</b><small>{error}</small><pre><code>{chart}</code></pre></div>;
  }
  if (!svg) return <div ref={hostRef} className="mermaid-loading">{visible ? <><span className="spinner" />正在渲染图表</> : "向下滚动以加载图表"}</div>;
  return <div ref={hostRef} className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
}
