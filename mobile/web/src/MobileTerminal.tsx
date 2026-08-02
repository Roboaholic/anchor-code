import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

function readableTerminalText(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, "")
    .replace(/\r/g, "")
    .slice(-60_000);
}

export function MobileTerminal({
  data,
  running,
  onInput,
  onResize,
}: {
  data: string;
  running: boolean;
  onInput: (value: string) => void;
  onResize: (cols: number, rows: number) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const previousDataRef = useRef("");
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  const writeQueueRef = useRef<string[]>([]);
  const writingRef = useRef(false);
  const pumpWritesRef = useRef<() => void>(() => undefined);
  const [renderError, setRenderError] = useState<string | null>(null);

  onInputRef.current = onInput;
  onResizeRef.current = onResize;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let terminal: Terminal;
    let fit: FitAddon;
    try {
      terminal = new Terminal({
        cursorBlink: true,
        cursorStyle: "bar",
        fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
        fontSize: 12,
        lineHeight: 1.18,
        scrollback: 5_000,
        convertEol: false,
        allowTransparency: true,
        theme: {
          background: "#070a0e",
          foreground: "#d2dbc9",
          cursor: "#d8ff67",
          cursorAccent: "#101409",
          selectionBackground: "#405027aa",
          black: "#11161c",
          red: "#ff7c83",
          green: "#d8ff67",
          yellow: "#ffc777",
          blue: "#79a7ff",
          magenta: "#c79cff",
          cyan: "#78dce8",
          white: "#dce3ea",
          brightBlack: "#66717e",
          brightRed: "#ff9da2",
          brightGreen: "#e5ff91",
          brightYellow: "#ffda9a",
          brightBlue: "#9bbcff",
          brightMagenta: "#d7b7ff",
          brightCyan: "#9ce7ef",
          brightWhite: "#ffffff",
        },
      });
      fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(host);
    } catch (error) {
      setRenderError(error instanceof Error ? error.message : "当前 Android WebView 无法初始化 xterm");
      return;
    }
    terminalRef.current = terminal;
    fitRef.current = fit;

    // xterm 6.0.0's production bundle can reference a missing enum variable
    // while handling ANSI/DEC mode-report queries (CSI Ps $ p / CSI ? Ps $ p).
    // Agent TUIs emit these queries during startup and reconnect. Registering a
    // user handler after open gives it priority over the built-in handler and
    // prevents one query from stopping all subsequent terminal rendering.
    const ansiModeQueryDisposable = terminal.parser.registerCsiHandler(
      { intermediates: "$", final: "p" },
      () => true,
    );
    const decModeQueryDisposable = terminal.parser.registerCsiHandler(
      { prefix: "?", intermediates: "$", final: "p" },
      () => true,
    );
    pumpWritesRef.current = () => {
      if (writingRef.current || !terminalRef.current) return;
      const next = writeQueueRef.current.shift();
      if (!next) return;
      writingRef.current = true;
      try {
        terminalRef.current.write(next, () => {
          writingRef.current = false;
          window.requestAnimationFrame(() => pumpWritesRef.current());
        });
      } catch (error) {
        writingRef.current = false;
        writeQueueRef.current = [];
        setRenderError(error instanceof Error ? error.message : "xterm 无法处理 Agent 输出");
      }
    };

    const inputDisposable = terminal.onData((value) => onInputRef.current(value));
    let resizeTimer = 0;
    let resizeFrame = 0;
    let lastWidth = 0;
    let lastHeight = 0;
    let lastCols = 0;
    let lastRows = 0;
    const fitAndReport = (force = false) => {
      const rect = host.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (!force && width === lastWidth && height === lastHeight) return;
      lastWidth = width;
      lastHeight = height;
      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        try {
          fit.fit();
          if (terminal.cols === lastCols && terminal.rows === lastRows) return;
          lastCols = terminal.cols;
          lastRows = terminal.rows;
          window.clearTimeout(resizeTimer);
          resizeTimer = window.setTimeout(() => {
            if (terminal.cols > 1 && terminal.rows > 1) {
              onResizeRef.current(terminal.cols, terminal.rows);
            }
          }, 120);
        } catch {
          // The terminal can briefly have zero dimensions during tab switches.
        }
      });
    };
    const observer = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => fitAndReport())
      : null;
    const onWindowResize = () => fitAndReport();
    if (observer) observer.observe(host);
    else window.addEventListener("resize", onWindowResize);
    requestAnimationFrame(() => {
      fitAndReport(true);
    });

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", onWindowResize);
      window.cancelAnimationFrame(resizeFrame);
      window.clearTimeout(resizeTimer);
      inputDisposable.dispose();
      ansiModeQueryDisposable.dispose();
      decModeQueryDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      writeQueueRef.current = [];
      writingRef.current = false;
      pumpWritesRef.current = () => undefined;
      previousDataRef.current = "";
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const previous = previousDataRef.current;
    let next = "";
    if (data.startsWith(previous)) {
      next = data.slice(previous.length);
    } else {
      terminal.reset();
      writeQueueRef.current = [];
      next = data;
    }
    if (next) {
      const chunkSize = 8 * 1024;
      for (let offset = 0; offset < next.length; offset += chunkSize) {
        writeQueueRef.current.push(next.slice(offset, offset + chunkSize));
      }
      pumpWritesRef.current();
    }
    previousDataRef.current = data;
  }, [data]);

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.disableStdin = !running;
  }, [running]);

  if (renderError) {
    return (
      <div className="terminal-plain-fallback" role="log" aria-label="Agent terminal fallback">
        <b>终端兼容模式</b>
        <small>{renderError}</small>
        <pre>{readableTerminalText(data) || "正在等待 PC 端 Agent 输出…"}</pre>
      </div>
    );
  }

  return (
    <div
      ref={hostRef}
      className="xterm-mobile"
      onClick={() => terminalRef.current?.focus()}
      role="application"
      aria-label="Agent terminal"
    />
  );
}
