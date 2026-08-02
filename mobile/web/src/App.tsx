import {
  Children,
  Component,
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import jsQR from "jsqr";
import { MobileTerminal } from "./MobileTerminal";
import { DiffDocument } from "./DiffDocument";
import { MermaidBlock } from "./MermaidBlock";
import { MobilePicker } from "./MobilePicker";
import type { RemoteCapability } from "@anchor-code/remote-contract/v1";
import {
  basename,
  dirname,
  joinPath,
  type AgentProfile,
  type Bootstrap,
  type Connection,
  type TerminalInfo,
} from "./api";
import {
  AnchorRepositories,
  type CommentRecord,
  type Commit,
  type DiffFile,
  type Entry,
  type RepoStatus,
  type Session,
  type WorkspaceCatalog,
  type WorkspaceOption,
} from "./repositories";

type Tab = "review" | "files" | "agent" | "comments";
const STORAGE_KEY = "anchor.mobile.connection.v1";
const RELAY_URL = "https://anchor-code-relay.anchor-code-mobile.workers.dev";

export function parsePairingPayload(value: string): Connection {
  const payload = JSON.parse(value) as Record<string, unknown>;
  const { relayUrl, roomId, hostPeerId, ticket, secret, expiresAt } = payload;
  if (payload.v !== 1 || payload.type !== "anchor-code-relay" ||
    typeof relayUrl !== "string" || typeof roomId !== "string" ||
    typeof hostPeerId !== "string" || typeof ticket !== "string" || typeof secret !== "string") {
    throw new Error("这不是有效的 Anchor Code 中继配对二维码");
  }
  if (relayUrl.replace(/\/+$/, "") !== RELAY_URL) {
    throw new Error("二维码不是 Anchor Code 官方中继地址");
  }
  if (typeof expiresAt === "string" && Date.parse(expiresAt) < Date.now()) {
    throw new Error("配对二维码已过期，请在 PC 上重新打开二维码");
  }
  return {
    mode: "relay",
    relayUrl: RELAY_URL,
    roomId,
    hostPeerId,
    peerId: `mobile-${crypto.randomUUID?.() ?? Math.random().toString(16).slice(2)}`,
    ticket,
    secret,
    ...(typeof expiresAt === "string" ? { expiresAt } : {}),
    paired: false,
  };
}

function readConnection(): Connection | null {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as Connection | null;
    return value?.mode === "relay" && value.relayUrl === RELAY_URL && value.ticket && value.secret
      ? value
      : null;
  } catch {
    return null;
  }
}

function formatCommitDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(date);
}

function Icon({ name }: { name: string }) {
  const glyphs: Record<string, string> = {
    review: "◫",
    files: "⌘",
    agent: "✦",
    comments: "◌",
    back: "‹",
    refresh: "↻",
    folder: "▱",
    file: "▤",
    search: "⌕",
    send: "↑",
    close: "×",
    link: "⌁",
    workspace: "▱",
    trash: "⌫",
  };
  return <span className="icon" aria-hidden>{glyphs[name] ?? "•"}</span>;
}

function Loading({ label = "正在加载" }: { label?: string }) {
  return <div className="loading"><span className="spinner" />{label}</div>;
}

function Empty({ title, hint }: { title: string; hint: string }) {
  return <div className="empty"><div className="empty__mark">A</div><h3>{title}</h3><p>{hint}</p></div>;
}

function PairingScanner({
  onClose,
  onDetected,
}: {
  onClose: () => void;
  onDetected: (connection: Connection) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const detectedRef = useRef(false);

  const decode = useCallback((image: CanvasImageSource, width: number, height: number) => {
    const canvas = canvasRef.current;
    if (!canvas || detectedRef.current || width < 1 || height < 1) return false;
    const maxEdge = 960;
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return false;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const result = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: "attemptBoth" });
    if (!result) return false;
    try {
      const connection = parsePairingPayload(result.data);
      detectedRef.current = true;
      onDetected(connection);
      return true;
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : String(scanError));
      return false;
    }
  }, [onDetected]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let frame = 0;
    let cancelled = false;
    const scan = () => {
      const video = videoRef.current;
      if (!cancelled && video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        if (!decode(video, video.videoWidth, video.videoHeight)) frame = requestAnimationFrame(scan);
      } else if (!cancelled) {
        frame = requestAnimationFrame(scan);
      }
    };
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("当前环境无法调用摄像头，请从相册选择二维码图片");
      return undefined;
    }
    void navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    }).then(async (nextStream) => {
      if (cancelled) {
        nextStream.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = nextStream;
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = nextStream;
      await video.play();
      setCameraReady(true);
      frame = requestAnimationFrame(scan);
    }).catch((cameraError) => {
      setError(cameraError instanceof Error && cameraError.name === "NotAllowedError"
        ? "未获得摄像头权限，可授权后重试或从相册选择二维码"
        : "无法启动摄像头，请从相册选择二维码图片");
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [decode]);

  const decodeFile = async (file?: File) => {
    if (!file) return;
    setError(null);
    try {
      const bitmap = await createImageBitmap(file);
      const found = decode(bitmap, bitmap.width, bitmap.height);
      bitmap.close();
      if (!found) setError("图片中没有识别到 Anchor Code 配对二维码");
    } catch (fileError) {
      setError(fileError instanceof Error ? fileError.message : "无法读取二维码图片");
    }
  };

  return (
    <div className="scanner-backdrop" role="dialog" aria-modal="true" aria-label="扫码连接">
      <section className="scanner-sheet">
        <div className="scanner-sheet__top">
          <div><span className="eyebrow">Quick pairing</span><h2>扫描 PC 配对码</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><Icon name="close" /></button>
        </div>
        <div className={`scanner-view${cameraReady ? " is-ready" : ""}`}>
          <video ref={videoRef} muted playsInline />
          <div className="scanner-frame"><i /><i /><i /><i /><span /></div>
          {!cameraReady && !error ? <div className="scanner-loading"><span className="spinner" />正在启动摄像头</div> : null}
        </div>
        <canvas ref={canvasRef} hidden />
        {error ? <div className="error-card">{error}</div> : null}
        <p className="scanner-hint">在 PC 端打开 设置 → Mobile access，将二维码完整放入取景框。</p>
        <input ref={inputRef} className="scanner-file" type="file" accept="image/*" onChange={(event) => void decodeFile(event.target.files?.[0])} />
        <button className="secondary-button" onClick={() => inputRef.current?.click()}>从相册选择二维码</button>
      </section>
    </div>
  );
}

function WorkspacePicker({
  catalog,
  currentRoot,
  onSelect,
  onRefresh,
  onClose,
  onDisconnect,
}: {
  catalog: WorkspaceCatalog;
  currentRoot: string | null;
  onSelect: (workspace: WorkspaceOption) => Promise<void>;
  onRefresh: () => Promise<void>;
  onClose?: () => void;
  onDisconnect: () => void;
}) {
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const select = async (workspace: WorkspaceOption) => {
    setBusyPath(`${workspace.hostProfileId}:${workspace.path}`);
    setError(null);
    try {
      await onSelect(workspace);
    } catch (selectError) {
      setError(selectError instanceof Error ? selectError.message : String(selectError));
      setBusyPath(null);
    }
  };

  return (
    <main className="workspace-picker">
      <div className="workspace-picker__glow" />
      <section className="workspace-picker__panel">
        <header className="workspace-picker__header">
          <div><span className="eyebrow">PC workspace</span><h1>选择工作区</h1></div>
          {onClose ? <button className="icon-button" onClick={onClose}><Icon name="close" /></button> : null}
        </header>
        <p className="workspace-picker__intro">选择一个曾在 PC Anchor Code 中打开过的工作区。切换会同步到电脑端。</p>
        {error ? <div className="error-card">{error}</div> : null}
        {catalog.recent.length ? (
          <div className="workspace-list">
            {catalog.recent.map((workspace) => {
              const key = `${workspace.hostProfileId}:${workspace.path}`;
              const active = workspace.path === currentRoot;
              return (
                <button className={`workspace-card${active ? " is-active" : ""}`} key={key} disabled={!!busyPath} onClick={() => void select(workspace)}>
                  <span className="workspace-card__icon"><Icon name="workspace" /></span>
                  <span className="workspace-card__copy"><b>{workspace.name}</b><small>{workspace.path}</small><em>{workspace.hostLabel} · {workspace.hostKind.toUpperCase()}</em></span>
                  <span className="workspace-card__state">{busyPath === key ? <span className="spinner" /> : active ? "当前" : "›"}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <Empty title="还没有可选工作区" hint="请先在 PC Anchor Code 中打开一个工作区，然后点击刷新。" />
        )}
        <div className="workspace-picker__actions">
          <button className="secondary-button" disabled={refreshing || !!busyPath} onClick={() => { setRefreshing(true); void onRefresh().catch((refreshError) => setError(refreshError instanceof Error ? refreshError.message : String(refreshError))).finally(() => setRefreshing(false)); }}>{refreshing ? <><span className="spinner" />正在刷新</> : <><Icon name="refresh" />刷新列表</>}</button>
          <button className="workspace-disconnect" onClick={onDisconnect}>断开这台 PC</button>
        </div>
      </section>
    </main>
  );
}

function ConnectionScreen({
  onConnected,
  onWorkspaceRequired,
}: {
  onConnected: (connection: Connection, bootstrap: Bootstrap) => void;
  onWorkspaceRequired: (connection: Connection, catalog: WorkspaceCatalog) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const connectAbortRef = useRef<AbortController | null>(null);

  useEffect(() => () => connectAbortRef.current?.abort(), []);

  const connect = async (connection: Connection) => {
    connectAbortRef.current?.abort();
    const controller = new AbortController();
    connectAbortRef.current = controller;
    setBusy(true);
    setError(null);
    try {
      const repositories = new AnchorRepositories(connection);
      await repositories.system.health({ signal: controller.signal });
      await repositories.system.negotiate({ signal: controller.signal });
      const catalog = await repositories.workspace.list({ signal: controller.signal });
      if (!catalog.active) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(connection));
        onWorkspaceRequired(connection, catalog);
        return;
      }
      const bootstrap = await repositories.system.bootstrap({ signal: controller.signal });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(connection));
      onConnected(connection, bootstrap);
    } catch (err) {
      setError(controller.signal.aborted ? "已取消连接，可以重新扫码后重试" : err instanceof Error ? err.message : String(err));
    } finally {
      if (connectAbortRef.current === controller) {
        connectAbortRef.current = null;
        setBusy(false);
      }
    }
  };

  return (
    <main className="connect">
      <div className="connect__glow" />
      <section className="connect__card">
        <div className="brand brand--large"><span className="brand__anchor">A</span><span><b>Anchor</b><small>Mobile Review</small></span></div>
        <div className="connect__copy">
          <p className="eyebrow">你的代码审阅台，随时在线</p>
          <h1>连接电脑上的<br />Anchor Code</h1>
          <p>在 PC 端打开“设置 → Mobile access”，扫描配对二维码，通过端到端加密中继安全连接。</p>
        </div>
        {error ? <div className="error-card">{error}</div> : null}
        {busy ? (
          <button className="secondary-button" onClick={() => connectAbortRef.current?.abort()}><span className="spinner" />取消连接</button>
        ) : (
          <button className="primary-button primary-button--scan" onClick={() => setScannerOpen(true)}><span className="scan-icon" />扫描 PC 配对二维码</button>
        )}
        <p className="connect__hint">连接使用 Anchor Code 加密中继，不需要填写 IP、端口或访问令牌。</p>
      </section>
      {scannerOpen ? <PairingScanner onClose={() => setScannerOpen(false)} onDetected={(connection) => {
        setScannerOpen(false);
        void connect(connection);
      }} /> : null}
    </main>
  );
}

class MarkdownErrorBoundary extends Component<
  { children: ReactNode; onShowSource: () => void },
  { error: string | null }
> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : "Markdown 渲染失败" };
  }

  componentDidCatch(error: unknown) {
    console.error("[markdown] render failed", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="document-error" role="alert">
        <b>文档预览失败</b>
        <p>{this.state.error}</p>
        <button onClick={this.props.onShowSource}>查看 Markdown 源码</button>
      </div>
    );
  }
}

class TerminalErrorBoundary extends Component<
  { children: ReactNode; sessionId: string },
  { error: string | null }
> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : "终端渲染失败" };
  }

  componentDidCatch(error: unknown) {
    console.error(`[terminal:${this.props.sessionId}] render failed`, error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="terminal-render-error" role="alert">
        <b>Agent 终端显示失败</b>
        <p>{this.state.error}</p>
        <small>会话仍在 PC 端运行。返回会话列表后可以重新进入。</small>
      </div>
    );
  }
}

function lastItem<T>(items: readonly T[]): T | undefined {
  return items.length ? items[items.length - 1] : undefined;
}

function lastLineLength(text: string): number {
  const lines = text.split("\n");
  return lastItem(lines)?.length ?? 0;
}

function CodeDocument({
  path,
  text,
  onComment,
}: {
  path: string;
  text: string;
  onComment: (selection: { start: number; end: number; text: string; before: string; after: string }) => void;
}) {
  const lines = useMemo(() => text.split("\n"), [text]);
  const markdown = path.toLowerCase().endsWith(".md") || path.toLowerCase().endsWith(".mdx");
  const [anchor, setAnchor] = useState<number | null>(null);
  const [end, setEnd] = useState<number | null>(null);
  const [preview, setPreview] = useState(markdown);
  const codeScrollRef = useRef<HTMLDivElement>(null);
  const startLine = anchor === null ? null : Math.min(anchor, end ?? anchor);
  const endLine = anchor === null ? null : Math.max(anchor, end ?? anchor);

  useEffect(() => {
    setPreview(markdown);
    setAnchor(null);
    setEnd(null);
    codeScrollRef.current?.scrollTo({ left: 0 });
  }, [markdown, path]);

  const selectLine = (index: number) => {
    if (anchor === null || end !== null) {
      setAnchor(index);
      setEnd(null);
    } else {
      setEnd(index);
    }
  };

  const comment = () => {
    if (startLine === null || endLine === null) return;
    onComment({
      start: startLine + 1,
      end: endLine + 1,
      text: lines.slice(startLine, endLine + 1).join("\n"),
      before: lines.slice(Math.max(0, startLine - 3), startLine).join("\n"),
      after: lines.slice(endLine + 1, endLine + 4).join("\n"),
    });
  };

  return (
    <div className="document">
      <div className="document__toolbar">
        <span className="document__name">{basename(path)}</span>
        {markdown ? <button className="chip" onClick={() => setPreview((v) => !v)}>{preview ? "查看源码" : "预览文档"}</button> : null}
      </div>
      {markdown && preview ? (
        <MarkdownErrorBoundary key={path} onShowSource={() => setPreview(false)}>
          <article className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
            pre({ children }) {
              const child = Children.toArray(children)[0];
              if (isValidElement<{ className?: string; children?: ReactNode }>(child) &&
                /\blanguage-mermaid\b/.test(child.props.className || "")) {
                return <MermaidBlock chart={String(child.props.children).replace(/\n$/, "")} />;
              }
              return <pre>{children}</pre>;
            },
            code({ className, children, ...props }) {
              return <code className={className} {...props}>{children}</code>;
            }
          }}>{text}</ReactMarkdown></article>
        </MarkdownErrorBoundary>
      ) : (
        <div className="code-lines">
          <div className="code-lines__gutter" aria-hidden>
            {lines.map((_, index) => {
              const selected = startLine !== null && endLine !== null && index >= startLine && index <= endLine;
              return <span key={index} className={`code-lines__number${selected ? " is-selected" : ""}`}>{index + 1}</span>;
            })}
          </div>
          <div className="code-lines__scroll" ref={codeScrollRef}>
            {lines.map((line, index) => {
              const selected = startLine !== null && endLine !== null && index >= startLine && index <= endLine;
              return <button key={index} className={`code-line${selected ? " is-selected" : ""}`} onClick={() => selectLine(index)}><code>{line || " "}</code></button>;
            })}
          </div>
        </div>
      )}
      {startLine !== null && !preview ? <div className="selection-bar"><span>{endLine === startLine ? `第 ${startLine + 1} 行` : `第 ${startLine + 1}–${(endLine ?? startLine) + 1} 行`}</span><button onClick={comment}>添加评论</button></div> : null}
    </div>
  );
}

function CommentComposer({
  selection,
  onClose,
  onSubmit,
}: {
  selection: { start: number; end: number; text: string };
  onClose: () => void;
  onSubmit: (body: string, needModify: boolean) => Promise<void>;
}) {
  const [body, setBody] = useState("");
  const [needModify, setNeedModify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy || !body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(body, needModify);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "评论保存失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  return <div className="sheet-backdrop" onClick={() => { if (!busy) onClose(); }}><section className="sheet" onClick={(e) => e.stopPropagation()}><div className="sheet__handle" /><div className="sheet__title"><div><span className="eyebrow">行 {selection.start}–{selection.end}</span><h3>添加审阅意见</h3></div><button className="icon-button" disabled={busy} onClick={onClose}><Icon name="close" /></button></div><pre className="selection-preview">{selection.text}</pre><textarea autoFocus rows={5} value={body} onChange={(e) => setBody(e.target.value)} placeholder="说明问题、建议或需要 Agent 修改的内容…" />{error ? <div className="comment-submit-error" role="alert">{error}</div> : null}<label className="switch-row"><span><b>需要修改</b><small>标记为 need_modify，方便 Agent 处理</small></span><input type="checkbox" checked={needModify} onChange={(e) => setNeedModify(e.target.checked)} /></label><button className="primary-button" disabled={busy || !body.trim()} onClick={() => void submit()}>{busy ? "正在保存…" : "保存评论"}</button></section></div>;
}

function FilesView({ repositories, bootstrap, notify }: ViewProps) {
  const root = bootstrap.workspace.root;
  const commentRoot = root;
  const [dir, setDir] = useState(root);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [file, setFile] = useState<{ path: string; text: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<Array<{ path: string; line: number; text: string }>>([]);
  const [selection, setSelection] = useState<null | { start: number; end: number; text: string; before: string; after: string }>(null);

  const loadDir = useCallback(async (path: string) => {
    setLoading(true);
    try {
      const result = await repositories.workspace.listFiles(path);
      setDir(path);
      setEntries([...result.entries].sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
      setFile(null);
    } finally { setLoading(false); }
  }, [repositories]);

  useEffect(() => { void loadDir(root); }, [loadDir, root]);

  const openEntry = async (entry: Entry) => {
    const path = joinPath(dir, entry.name);
    if (entry.type === "dir") { await loadDir(path); return; }
    setLoading(true);
    try { setFile(await repositories.workspace.readFile(path)); }
    finally { setLoading(false); }
  };

  const runSearch = async () => {
    if (!search.trim()) { setHits([]); return; }
    setLoading(true);
    try {
      const result = await repositories.workspace.search(search);
      setHits(result.hits);
    } finally { setLoading(false); }
  };

  const saveComment = async (body: string, needModify: boolean) => {
    if (!file || !selection) return;
    const session = await repositories.comments.add({
      repoRoot: commentRoot,
      filePath: file.path,
      kind: file.path.toLowerCase().endsWith(".md") ? "markdown" : "source",
      startLine: selection.start,
      endLine: selection.end,
      startColumn: 1,
      endColumn: Math.max(2, lastLineLength(selection.text)),
      selectedText: selection.text,
      beforeContext: selection.before,
      afterContext: selection.after,
      body,
    });
    const added = lastItem(session.comments);
    if (needModify && added) await repositories.comments.setStatus(commentRoot, added.id, "need_modify");
    setSelection(null);
    notify("评论已保存");
  };

  if (file) return <section className="view"><header className="view-header"><button className="back-button" onClick={() => setFile(null)}><Icon name="back" /></button><div><span className="eyebrow">{file.path.replace(root, "") || "/"}</span><h2>{basename(file.path)}</h2></div></header><CodeDocument path={file.path} text={file.text} onComment={setSelection} />{selection ? <CommentComposer selection={selection} onClose={() => setSelection(null)} onSubmit={saveComment} /> : null}</section>;

  return <section className="view"><header className="view-header"><div><span className="eyebrow">浏览工作区</span><h2>文件与文档</h2></div><button className="icon-button" onClick={() => void loadDir(dir)}><Icon name="refresh" /></button></header><div className="search-box"><Icon name="search" /><input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void runSearch(); }} placeholder="搜索代码内容" /><button onClick={() => void runSearch()}>搜索</button></div>{dir !== root && !hits.length ? <button className="breadcrumb" onClick={() => void loadDir(dirname(dir))}><Icon name="back" />{basename(dir)}</button> : null}{loading ? <Loading /> : hits.length ? <div className="list">{hits.map((hit, i) => <button className="search-hit" key={`${hit.path}:${hit.line}:${i}`} onClick={async () => { const path = joinPath(root, hit.path); setFile(await repositories.workspace.readFile(path)); }}><b>{hit.path}</b><small>第 {hit.line} 行</small><p>{hit.text}</p></button>)}</div> : <div className="list">{entries.map((entry) => <button className="file-row" key={entry.name} onClick={() => void openEntry(entry)}><span className={`file-row__icon file-row__icon--${entry.type}`}><Icon name={entry.type === "dir" ? "folder" : "file"} /></span><span><b>{entry.name}</b><small>{entry.type === "dir" ? "文件夹" : basename(entry.name).split(".").pop()?.toUpperCase() || "FILE"}</small></span><Icon name="back" /></button>)}</div>}</section>;
}

function ReviewView({ repositories, bootstrap, notify, supports }: ViewProps) {
  const commentRoot = bootstrap.workspace.root;
  const [repoRoot, setRepoRoot] = useState(bootstrap.repos[0]?.root ?? bootstrap.workspace.root);
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [base, setBase] = useState("");
  const [diffFiles, setDiffFiles] = useState<DiffFile[]>([]);
  const [activeDiff, setActiveDiff] = useState<{ path: string; oldText: string; newText: string; status: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [selection, setSelection] = useState<null | { start: number; end: number; text: string; before: string; after: string }>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextStatus, nextCommits] = await Promise.all([
        repositories.review.status(repoRoot),
        repositories.review.log(repoRoot),
      ]);
      setStatus(nextStatus);
      setCommits(nextCommits);
      setBase((value) => nextCommits.some((commit) => commit.hash === value) ? value : nextCommits[0]?.hash || "");
    } finally { setLoading(false); }
  }, [repositories, repoRoot]);
  useEffect(() => { void load(); }, [load]);

  const compare = async () => {
    if (!base) return;
    setLoading(true);
    try {
      const result = await repositories.review.compare({ repoRoot, base, head: "worktree" });
      setDiffFiles(result.files);
    } finally { setLoading(false); }
  };

  const openDiff = async (file: DiffFile) => {
    setLoading(true);
    try { setActiveDiff(await repositories.review.fileDiff({ repoRoot, base, head: "worktree", path: file.path, status: file.status })); }
    finally { setLoading(false); }
  };

  const saveComment = async (body: string, needModify: boolean) => {
    if (!activeDiff || !selection) return;
    const session = await repositories.comments.add({
      repoRoot: commentRoot,
      filePath: joinPath(repoRoot, activeDiff.path),
      kind: activeDiff.path.toLowerCase().endsWith(".md") ? "markdown" : "source",
      startLine: selection.start,
      endLine: selection.end,
      startColumn: 1,
      endColumn: Math.max(2, lastLineLength(selection.text)),
      selectedText: selection.text,
      beforeContext: selection.before,
      afterContext: selection.after,
      body,
    });
    const added = lastItem(session.comments);
    if (needModify && added) await repositories.comments.setStatus(commentRoot, added.id, "need_modify");
    setSelection(null);
    notify("审阅意见已记录");
  };

  if (activeDiff) return <section className="view"><header className="view-header"><button className="back-button" onClick={() => setActiveDiff(null)}><Icon name="back" /></button><div><span className="eyebrow">{activeDiff.status} · 工作区版本</span><h2>{activeDiff.path}</h2></div></header><DiffDocument path={activeDiff.path} oldText={activeDiff.oldText} newText={activeDiff.newText} onComment={setSelection} allowSideBySide={supports("review.side-by-side-diff")} allowComments={supports("comments.lifecycle")} />{selection ? <CommentComposer selection={selection} onClose={() => setSelection(null)} onSubmit={saveComment} /> : null}</section>;

  return <section className="view"><header className="view-header"><div><span className="eyebrow">Human in the loop</span><h2>Review 变更</h2></div><button className="icon-button" onClick={() => void load()}><Icon name="refresh" /></button></header>{bootstrap.repos.length > 1 ? <MobilePicker className="repo-picker" label="仓库" value={repoRoot} options={bootstrap.repos.map((repo) => ({ value: repo.root, title: repo.name, subtitle: repo.root }))} onChange={(value) => { setRepoRoot(value); setBase(""); setDiffFiles([]); }} /> : null}{loading ? <Loading /> : <><div className="status-card"><div><span className="status-card__branch">{status?.branch || "detached"}</span><h3>{basename(repoRoot)}</h3><p>从一个提交开始，审阅当前工作区的代码和文档变更。</p></div><div className="status-metrics"><span><b>{status?.modified ?? 0}</b>修改</span><span><b>{status?.added ?? 0}</b>新增</span><span><b>{status?.deleted ?? 0}</b>删除</span></div></div><div className="compare-card"><MobilePicker label="比较基线" value={base} options={commits.slice(0, 40).map((commit) => ({ value: commit.hash, title: commit.subject, subtitle: `${commit.author} · ${formatCommitDate(commit.dateIso)}`, badge: commit.shortHash }))} onChange={setBase} placeholder="选择 Commit" /><button className="primary-button" disabled={!base} onClick={() => void compare()}>比较当前工作区</button></div>{diffFiles.length ? <div className="section-block"><div className="section-title"><span>Changed files</span><b>{diffFiles.length}</b></div><div className="list">{diffFiles.map((file) => <button className="diff-row" key={file.path} onClick={() => void openDiff(file)}><span className={`diff-badge diff-badge--${file.status.toLowerCase()}`}>{file.status}</span><span>{file.path}</span><Icon name="back" /></button>)}</div></div> : status?.entries.length ? <div className="section-block"><div className="section-title"><span>待审阅变更</span><b>{status.entries.length}</b></div><div className="list">{status.entries.map((file) => <div className="diff-row" key={file.path}><span className="diff-badge">{file.code.trim() || "M"}</span><span>{file.path}</span></div>)}</div></div> : <Empty title="工作区很干净" hint="PC 上产生代码变更后，下拉刷新即可开始审阅。" />}</>}</section>;
}

function AgentView({ repositories, bootstrap, terminals, outputs, onTerminalCreated, onTerminalDeleted, onOutputSnapshot, onActiveChange, notify }: ViewProps & {
  terminals: TerminalInfo[];
  outputs: Record<string, string>;
  onTerminalCreated: (terminal: TerminalInfo) => void;
  onTerminalDeleted: (id: string) => void;
  onOutputSnapshot: (id: string, data: string, seq: number) => void;
  onActiveChange: (active: boolean) => void;
}) {
  const agents = bootstrap.agents.filter((agent) => agent.enabled !== false);
  const [profileId, setProfileId] = useState(bootstrap.defaultAgentId ?? agents[0]?.id ?? "");
  const [prompt, setPrompt] = useState("");
  // Existing PC sessions belong in the session list. Do not automatically open
  // one while AgentView is mounted in a hidden tab, otherwise its fullscreen
  // state leaks into Review/Files and hides the global navigation.
  const [activeId, setActiveId] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [createdTerminal, setCreatedTerminal] = useState<TerminalInfo | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TerminalInfo | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [syncingOutput, setSyncingOutput] = useState(false);
  const outputsRef = useRef(outputs);
  const inputStateRef = useRef<{ id: string; data: string; timer: number; chain: Promise<unknown> }>({ id: "", data: "", timer: 0, chain: Promise.resolve() });
  const snapshotSeqRef = useRef<Record<string, number>>({});
  const active = terminals.find((item) => item.id === activeId)
    ?? (createdTerminal?.id === activeId ? createdTerminal : undefined);

  outputsRef.current = outputs;

  useEffect(() => {
    if (createdTerminal && terminals.some((item) => item.id === createdTerminal.id)) {
      setCreatedTerminal(null);
    }
  }, [createdTerminal, terminals]);

  useEffect(() => {
    onActiveChange(Boolean(active));
    return () => onActiveChange(false);
  }, [active, onActiveChange]);

  const enqueueTerminalInput = useCallback((id: string, data: string) => {
    const state = inputStateRef.current;
    const operation = state.chain.then(() => repositories.terminal.input(id, data));
    state.chain = operation.then(
      () => setTerminalError(null),
      (inputError) => setTerminalError(inputError instanceof Error ? inputError.message : "终端输入发送失败"),
    );
    return operation;
  }, [repositories]);

  const flushTerminalInput = useCallback(() => {
    const state = inputStateRef.current;
    window.clearTimeout(state.timer);
    state.timer = 0;
    if (!state.id || !state.data) return state.chain;
    const id = state.id;
    const data = state.data;
    state.data = "";
    return enqueueTerminalInput(id, data);
  }, [enqueueTerminalInput]);

  const queueTerminalInput = useCallback((data: string) => {
    if (!active?.id || !data) return;
    const state = inputStateRef.current;
    if (state.id && state.id !== active.id && state.data) void flushTerminalInput();
    state.id = active.id;
    state.data += data;
    window.clearTimeout(state.timer);
    const immediate = /[\r\n\u0003\u001b]/.test(data) || state.data.length >= 96;
    state.timer = window.setTimeout(() => { void flushTerminalInput(); }, immediate ? 0 : 28);
  }, [active?.id, flushTerminalInput]);

  const sendTerminalInput = useCallback((data: string) => {
    if (!active?.id || !data) return Promise.resolve();
    const state = inputStateRef.current;
    if (state.id && state.id !== active.id && state.data) void flushTerminalInput();
    state.id = active.id;
    state.data += data;
    return flushTerminalInput();
  }, [active?.id, flushTerminalInput]);

  useEffect(() => () => {
    window.clearTimeout(inputStateRef.current.timer);
    if (inputStateRef.current.data) void flushTerminalInput();
  }, [flushTerminalInput]);
  useEffect(() => {
    if (!activeId) {
      setSyncingOutput(false);
      return;
    }
    let cancelled = false;
    let pollTimer = 0;
    let consecutiveFailures = 0;

    const sync = async () => {
      if (cancelled) return;
      if (!outputsRef.current[activeId]) setSyncingOutput(true);
      try {
        const knownSeq = snapshotSeqRef.current[activeId] ?? -1;
        const snapshot = await repositories.terminal.snapshot(activeId, knownSeq);
        if (cancelled) return;
        snapshotSeqRef.current[snapshot.id] = Math.max(knownSeq, snapshot.seq);
        if (!snapshot.unchanged) {
          onOutputSnapshot(snapshot.id, snapshot.data, snapshot.seq);
          console.info(`[agent-sync] snapshot id=${snapshot.id} seq=${snapshot.seq} chars=${snapshot.data.length}`);
        }
        consecutiveFailures = 0;
        setTerminalError(null);
        if (snapshot.data || outputsRef.current[activeId]) setSyncingOutput(false);
      } catch (snapshotError) {
        if (cancelled) return;
        consecutiveFailures += 1;
        if (consecutiveFailures >= 3 && !outputsRef.current[activeId]) {
          setTerminalError(snapshotError instanceof Error ? snapshotError.message : "终端输出同步失败");
        }
      }
      if (!cancelled) {
        // Event long-polling is the fast path. Repeated snapshots are the
        // recovery path for missed events, reconnects, and late model output.
        const delay = outputsRef.current[activeId] ? 2_500 : 700;
        pollTimer = window.setTimeout(() => { void sync(); }, delay);
      }
    };

    void sync();
    return () => {
      cancelled = true;
      window.clearTimeout(pollTimer);
    };
  }, [activeId, repositories, onOutputSnapshot]);

  const launch = async () => {
    if (!profileId) return;
    setBusy(true);
    setLaunchError(null);
    setTerminalError(null);
    try {
      const terminal = await repositories.agent.createSession({ profileId, prompt, cols: 64, rows: 30 });
      if (!terminal.id) throw new Error("PC 已响应，但没有返回有效的 Agent 会话编号");
      // Keep the returned session locally until the parent list/event stream has
      // caught up. This prevents the terminal screen from rendering as empty
      // during relay/event synchronization.
      setCreatedTerminal(terminal);
      onTerminalCreated(terminal);
      setActiveId(terminal.id);
      setPrompt("");
      notify("Agent 会话已启动");
    } catch (launchFailure) {
      setLaunchError(launchFailure instanceof Error ? launchFailure.message : "Agent 会话启动失败");
    } finally { setBusy(false); }
  };
  const send = async () => {
    if (!active || !message) return;
    try {
      await sendTerminalInput(`${message}\r`);
      setMessage("");
    } catch {
      // The inline connection error keeps the unsent message available for retry.
    }
  };

  const resyncTerminal = async () => {
    if (!active) return;
    try {
      const snapshot = await repositories.terminal.snapshot(active.id);
      snapshotSeqRef.current[snapshot.id] = snapshot.seq;
      onOutputSnapshot(snapshot.id, snapshot.data, snapshot.seq);
      setTerminalError(null);
    } catch (syncError) {
      setTerminalError(syncError instanceof Error ? syncError.message : "终端重新连接失败");
    }
  };

  const deleteTerminal = async () => {
    if (!deleteTarget || deleting) return;
    const target = deleteTarget;
    setDeleting(true);
    try {
      const inputState = inputStateRef.current;
      if (inputState.id === target.id) {
        window.clearTimeout(inputState.timer);
        inputState.id = "";
        inputState.data = "";
        inputState.timer = 0;
      }
      await repositories.terminal.remove(target.id);
      onTerminalDeleted(target.id);
      setActiveId((value) => value === target.id ? "" : value);
      setDeleteTarget(null);
      notify("Agent 会话已删除");
    } catch (deleteError) {
      setTerminalError(deleteError instanceof Error ? deleteError.message : "Agent 会话删除失败");
    } finally {
      setDeleting(false);
    }
  };

  const deleteDialog = deleteTarget ? (
    <div className="sheet-backdrop delete-session-backdrop" role="presentation" onClick={() => { if (!deleting) setDeleteTarget(null); }}>
      <section className="sheet delete-session-sheet" role="dialog" aria-modal="true" aria-labelledby="delete-session-title" onClick={(event) => event.stopPropagation()}>
        <div className="sheet__handle" />
        <span className="eyebrow">Delete agent session</span>
        <h3 id="delete-session-title">删除“{deleteTarget.title}”？</h3>
        <p>这会终止 PC 上正在运行的 Agent，并从 PC 与 APK 的会话列表中同时移除。</p>
        <div className="delete-session-actions">
          <button className="secondary-button" disabled={deleting} onClick={() => setDeleteTarget(null)}>取消</button>
          <button className="danger-button" disabled={deleting} onClick={() => void deleteTerminal()}>{deleting ? "正在删除…" : "删除会话"}</button>
        </div>
      </section>
    </div>
  ) : null;

  if (active) return (
    <section className="view agent-view">
      <header className="view-header agent-terminal-header">
        <button className="back-button" onClick={() => setActiveId("")} aria-label="返回 Agent 会话列表"><Icon name="back" /></button>
        <div>
          <span className="eyebrow">{active.status} · {active.agentId || "Agent"}</span>
          <h2>{active.title}</h2>
        </div>
        <button className="icon-button agent-delete-button" onClick={() => setDeleteTarget(active)} aria-label={`删除 ${active.title}`} title="删除会话"><Icon name="trash" /></button>
      </header>
      <TerminalErrorBoundary key={active.id} sessionId={active.id}>
        <div className="terminal-stage">
          <MobileTerminal
            data={outputs[active.id] || ""}
            running={active.status === "running"}
            onInput={queueTerminalInput}
            onResize={(cols, rows) => {
              void repositories.terminal.resize(active.id, cols, rows).catch((resizeError) => setTerminalError(resizeError instanceof Error ? resizeError.message : "终端尺寸同步失败"));
            }}
          />
          {!outputs[active.id] && !terminalError ? <div className="terminal-sync-state" role="status"><span className="spinner" />{syncingOutput ? "正在同步 PC 端 Agent 输出" : "等待 Agent 输出"}</div> : null}
        </div>
      </TerminalErrorBoundary>
      {terminalError ? <div className="terminal-alert"><span><b>终端连接异常</b><small>{terminalError}</small></span><button onClick={() => void resyncTerminal()}>重新同步</button></div> : null}
      <div className="quick-keys"><button onClick={() => void sendTerminalInput("\u0003")}>Ctrl+C</button><button onClick={() => void sendTerminalInput("\t")}>Tab</button><button onClick={() => void sendTerminalInput("\u001b")}>Esc</button><button onClick={() => void sendTerminalInput("\r")}>Enter</button><button onClick={() => void sendTerminalInput("\u001b[A")}>↑</button><button onClick={() => void sendTerminalInput("\u001b[B")}>↓</button></div>
      <div className="agent-composer"><textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="也可以直接点击终端，使用系统键盘操作完整 TUI…" /><button disabled={!message.trim()} onClick={() => void send()}><Icon name="send" /></button></div>
      {deleteDialog}
    </section>
  );

  const agentSessions = terminals.filter((item) => item.kind === "agent");
  return (
    <section className="view">
      <header className="view-header"><div><span className="eyebrow">Remote terminal</span><h2>与 Agent 协作</h2></div></header>
      <div className="agent-hero"><span className="agent-hero__orb">✦</span><h3>把反馈交给 Agent</h3><p>直接在工作区启动 Codex、Claude Code 等 CLI，会话在 PC 上持续运行。</p></div>
      <div className="agent-launch"><MobilePicker className="agent-profile-picker" label="Agent" value={profileId} options={agents.map((agent: AgentProfile) => ({ value: agent.id, title: agent.name, subtitle: agent.command, badge: agent.detected === true ? "可用" : agent.detected === false ? "未检测" : undefined }))} onChange={setProfileId} placeholder="选择 Agent" /><label className="field"><span>任务</span><textarea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="例如：读取 .anchor-code 会话，处理所有 need_modify 评论并运行测试。" /></label>{launchError ? <div className="error-card agent-launch-error" role="alert">{launchError}</div> : null}<button className="primary-button" disabled={busy || !profileId} onClick={() => void launch()}>{busy ? "正在启动…" : "启动 Agent 会话"}</button></div>
      {agentSessions.length ? <div className="section-block"><div className="section-title"><span>最近会话</span><b>{agentSessions.length}</b></div><div className="list">{agentSessions.map((terminal) => <div className="session-row agent-session-row" key={terminal.id}><button className="agent-session-open" onClick={() => setActiveId(terminal.id)}><span className={`presence${terminal.status === "running" ? " is-online" : ""}`} /><span><b>{terminal.title}</b><small>{terminal.status === "running" ? "运行中 · 已与 PC 同步" : "已退出 · 可删除"}</small></span><Icon name="back" /></button><button className="session-delete-button" onClick={() => setDeleteTarget(terminal)} aria-label={`删除 ${terminal.title}`} title="删除会话"><Icon name="trash" /></button></div>)}</div></div> : null}
      {deleteDialog}
    </section>
  );
}

function CommentsView({ repositories, bootstrap, notify }: ViewProps) {
  const repoRoot = bootstrap.workspace.root;
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [reply, setReply] = useState<Record<string, string>>({});
  const load = useCallback(async () => { setLoading(true); try { const result = await repositories.comments.list(repoRoot); setSessions(result.sessions); } finally { setLoading(false); } }, [repositories, repoRoot]);
  useEffect(() => { void load(); }, [load]);
  const active = sessions.find((session) => session.status === "active");
  const setStatus = async (comment: CommentRecord, status: CommentRecord["status"]) => { await repositories.comments.setStatus(repoRoot, comment.id, status); await load(); notify("状态已更新"); };
  const sendReply = async (comment: CommentRecord) => { const body = reply[comment.id]?.trim(); if (!body) return; await repositories.comments.reply(repoRoot, comment.id, body); setReply((value) => ({ ...value, [comment.id]: "" })); await load(); };

  return <section className="view"><header className="view-header"><div><span className="eyebrow">Structured feedback</span><h2>Comments</h2></div><button className="icon-button" onClick={() => void load()}><Icon name="refresh" /></button></header>{loading ? <Loading /> : !active ? <Empty title="还没有活跃审阅" hint="在代码或文档中选择行并添加第一条评论。" /> : <><div className="session-card"><span className="presence is-online" /><div><span className="eyebrow">Active session</span><h3>{active.title}</h3><p>{active.comments.length} 条评论 · {active.filePath || "已保存到工作区"}</p></div></div><div className="comment-list">{active.comments.map((comment) => <article className="comment-card" key={comment.id}><div className="comment-card__top"><span className={`comment-status comment-status--${comment.status}`}>{comment.status}</span><span>{comment.target.file_path}:{comment.target.start_line}</span></div><pre>{comment.target.selected_text}</pre>{comment.messages.map((message) => <div className="comment-message" key={message.id}><b>{message.author}</b><p>{message.body}</p></div>)}<div className="status-actions"><button className={comment.status === "discussing" ? "is-active" : ""} onClick={() => void setStatus(comment, "discussing")}>讨论</button><button className={comment.status === "need_modify" ? "is-active" : ""} onClick={() => void setStatus(comment, "need_modify")}>需修改</button><button className={comment.status === "closed" ? "is-active" : ""} onClick={() => void setStatus(comment, "closed")}>关闭</button></div><div className="reply-box"><input value={reply[comment.id] || ""} onChange={(e) => setReply((value) => ({ ...value, [comment.id]: e.target.value }))} placeholder="回复评论" /><button onClick={() => void sendReply(comment)}><Icon name="send" /></button></div></article>)}</div></>}</section>;
}

interface ViewProps {
  repositories: AnchorRepositories;
  bootstrap: Bootstrap;
  notify: (message: string) => void;
  supports: (capability: RemoteCapability) => boolean;
}

export interface AppOverrides {
  initialConnection?: Connection;
  initialBootstrap?: Bootstrap;
  repositories?: AnchorRepositories;
}

export default function App({ initialConnection, initialBootstrap, repositories: repositoriesOverride }: AppOverrides = {}) {
  const [connection, setConnection] = useState<Connection | null>(() => initialConnection ?? readConnection());
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(initialBootstrap ?? null);
  const [tab, setTab] = useState<Tab>("review");
  const [connecting, setConnecting] = useState(!initialBootstrap && !!connection);
  const [workspaceCatalog, setWorkspaceCatalog] = useState<WorkspaceCatalog | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [terminals, setTerminals] = useState<TerminalInfo[]>(initialBootstrap?.terminals ?? []);
  const [outputs, setOutputs] = useState<Record<string, string>>({});
  const [remoteState, setRemoteState] = useState<"online" | "reconnecting">("online");
  const [agentFullscreen, setAgentFullscreen] = useState(false);
  const cursorRef = useRef(initialBootstrap?.terminalCursor ?? 0);
  const outputSeqRef = useRef<Record<string, number>>({});
  const serverInstanceRef = useRef<string | null>(initialBootstrap?.serverInstanceId ?? null);
  const tabScrollRef = useRef<Record<Tab, number>>({ review: 0, files: 0, agent: 0, comments: 0 });
  const repositories = useMemo(() => connection ? repositoriesOverride ?? new AnchorRepositories(connection) : null, [connection, repositoriesOverride]);

  const notify = useCallback((message: string) => { setToast(message); window.setTimeout(() => setToast(null), 2400); }, []);
  const handleTerminalCreated = useCallback((terminal: TerminalInfo) => {
    setTerminals((value) => value.some((item) => item.id === terminal.id)
      ? value.map((item) => item.id === terminal.id ? terminal : item)
      : [...value, terminal]);
  }, []);
  const handleTerminalDeleted = useCallback((id: string) => {
    setTerminals((value) => value.filter((item) => item.id !== id));
    delete outputSeqRef.current[id];
    setOutputs((value) => {
      if (!(id in value)) return value;
      const next = { ...value };
      delete next[id];
      return next;
    });
  }, []);
  const handleOutputSnapshot = useCallback((id: string, data: string, seq: number) => {
    const previousSeq = outputSeqRef.current[id] ?? -1;
    if (seq < previousSeq) return;
    outputSeqRef.current[id] = seq;
    setOutputs((value) => value[id] === data ? value : { ...value, [id]: data });
  }, []);
  const connected = useCallback((nextConnection: Connection, nextBootstrap: Bootstrap) => {
    setConnection(nextConnection);
    setBootstrap(nextBootstrap);
    setWorkspaceCatalog(null);
    setTerminals(nextBootstrap.terminals);
    setOutputs({});
    outputSeqRef.current = {};
    cursorRef.current = nextBootstrap.terminalCursor;
    serverInstanceRef.current = nextBootstrap.serverInstanceId;
    setRemoteState("online");
    setConnecting(false);
  }, []);

  useEffect(() => {
    if (!repositories || bootstrap || workspaceCatalog) return;
    let cancelled = false;
    void repositories.system.negotiate().then(() => repositories.workspace.list()).then(async (catalog) => {
      if (cancelled) return;
      if (!catalog.active) {
        setWorkspaceCatalog(catalog);
        setConnecting(false);
        return;
      }
      connected(connection!, await repositories.system.bootstrap());
    }).catch(() => { if (!cancelled) setConnecting(false); });
    return () => { cancelled = true; };
  }, [repositories, bootstrap, connected, connection, workspaceCatalog]);

  const disconnect = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setConnection(null);
    setBootstrap(null);
    setWorkspaceCatalog(null);
    setTerminals([]);
    setOutputs({});
    outputSeqRef.current = {};
    setAgentFullscreen(false);
    tabScrollRef.current = { review: 0, files: 0, agent: 0, comments: 0 };
    serverInstanceRef.current = null;
    setConnecting(false);
  }, []);

  const selectTab = useCallback((nextTab: Tab) => {
    if (nextTab === tab) return;
    tabScrollRef.current[tab] = window.scrollY;
    setTab(nextTab);
    window.requestAnimationFrame(() => window.scrollTo(0, tabScrollRef.current[nextTab]));
  }, [tab]);

  const refreshWorkspaces = useCallback(async () => {
    if (!repositories) return;
    setWorkspaceCatalog(await repositories.workspace.list());
  }, [repositories]);

  const selectWorkspace = useCallback(async (workspace: WorkspaceOption) => {
    if (!repositories || !connection) return;
    await repositories.workspace.select({
      path: workspace.path,
      hostProfileId: workspace.hostProfileId,
    });
    const next = await repositories.system.bootstrap();
    setOutputs({});
    outputSeqRef.current = {};
    setTab("review");
    tabScrollRef.current = { review: 0, files: 0, agent: 0, comments: 0 };
    setAgentFullscreen(false);
    connected(connection, next);
  }, [repositories, connected, connection]);

  useEffect(() => {
    if (!repositories || !bootstrap) return;
    if (!repositories.supports("terminal.long-poll-events")) return;
    let stopped = false;
    const poll = async () => {
      while (!stopped) {
        try {
          const result = await repositories.terminal.pollEvents(cursorRef.current);
          setRemoteState("online");
          if (result.bootstrapRequired) {
            const next = await repositories.system.bootstrap();
            if (!stopped && connection) connected(connection, next);
            continue;
          }
          if (serverInstanceRef.current && result.serverInstanceId !== serverInstanceRef.current) {
            const next = await repositories.system.bootstrap();
            if (!stopped && connection) connected(connection, next);
            continue;
          }
          cursorRef.current = result.cursor;
          let workspaceChanged = false;
          for (const item of result.events) {
            const event = item.event;
            if (event.type === "workspace") {
              workspaceChanged = true;
            } else if (event.type === "data" && event.data) {
              const previousSeq = outputSeqRef.current[event.id] ?? 0;
              if (event.seq <= previousSeq) continue;
              const hasGap = event.seq > previousSeq + 1;
              outputSeqRef.current[event.id] = event.seq;
              setOutputs((value) => ({ ...value, [event.id]: `${value[event.id] || ""}${event.data}`.slice(-240_000) }));
              if (hasGap) {
                void repositories.terminal.snapshot(event.id).then((snapshot) => {
                  handleOutputSnapshot(snapshot.id, snapshot.data, snapshot.seq);
                }).catch(() => undefined);
              }
            } else if (event.type === "created" || event.type === "updated") {
              handleTerminalCreated(event.info);
            } else if (event.type === "exit") {
              setTerminals((value) => value.map((terminal) => terminal.id === event.id ? { ...terminal, status: "exited" } : terminal));
            } else if (event.type === "removed") {
              handleTerminalDeleted(event.id);
            }
          }
          if (workspaceChanged) {
            const next = await repositories.system.bootstrap();
            if (!stopped && connection) {
              setOutputs({});
              outputSeqRef.current = {};
              setAgentFullscreen(false);
              connected(connection, next);
            }
          }
        } catch {
          setRemoteState("reconnecting");
          await new Promise((resolve) => window.setTimeout(resolve, 1800));
        }
      }
    };
    void poll();
    return () => { stopped = true; };
  }, [repositories, bootstrap, connection, connected, handleTerminalCreated, handleTerminalDeleted, handleOutputSnapshot]);

  if (!connection) return <ConnectionScreen onConnected={connected} onWorkspaceRequired={(nextConnection, catalog) => { setConnection(nextConnection); setWorkspaceCatalog(catalog); setConnecting(false); }} />;
  if (workspaceCatalog && !bootstrap) return <WorkspacePicker catalog={workspaceCatalog} currentRoot={null} onSelect={selectWorkspace} onRefresh={refreshWorkspaces} onDisconnect={disconnect} />;
  if (!bootstrap && !connecting) return <ConnectionScreen onConnected={connected} onWorkspaceRequired={(nextConnection, catalog) => { setConnection(nextConnection); setWorkspaceCatalog(catalog); setConnecting(false); }} />;
  if (!repositories || !bootstrap) return <main className="splash"><div className="brand brand--large"><span className="brand__anchor">A</span><span><b>Anchor</b><small>正在连接 PC</small></span></div><Loading label="同步工作区" /></main>;

  const supports = (capability: RemoteCapability) => repositories.supports(capability);
  const viewProps = { repositories, bootstrap, notify, supports };
  const tabs: Tab[] = [
    "review",
    "files",
    ...(supports("agent.session-sync") && supports("terminal.long-poll-events") ? ["agent" as const] : []),
    ...(supports("comments.lifecycle") ? ["comments" as const] : []),
  ];
  const showAgentFullscreen = tab === "agent" && agentFullscreen;
  return <main className={`app-shell${showAgentFullscreen ? " app-shell--agent-terminal" : ""}`}><header className="app-top"><button className="brand brand-switch" disabled={!supports("workspace.select")} onClick={() => void refreshWorkspaces()}><span className="brand__anchor">A</span><span><b>Anchor</b><small>{bootstrap.workspace.name}{supports("workspace.select") ? "⌄" : ""}</small></span></button><button className={`connection-pill${remoteState === "reconnecting" ? " is-reconnecting" : ""}`} onClick={disconnect}><span />{remoteState === "online" ? "PC 在线" : "正在重连"}</button></header><div className="app-content" key={bootstrap.workspace.root}><div className="tab-panel" hidden={tab !== "review"}><ReviewView {...viewProps} /></div><div className="tab-panel" hidden={tab !== "files"}><FilesView {...viewProps} /></div>{tabs.includes("agent") ? <div className="tab-panel" hidden={tab !== "agent"}><AgentView {...viewProps} terminals={terminals} outputs={outputs} onTerminalCreated={handleTerminalCreated} onTerminalDeleted={handleTerminalDeleted} onOutputSnapshot={handleOutputSnapshot} onActiveChange={setAgentFullscreen} /></div> : null}{tabs.includes("comments") ? <div className="tab-panel" hidden={tab !== "comments"}><CommentsView {...viewProps} /></div> : null}</div><nav className="bottom-nav">{tabs.map((item) => <button key={item} className={tab === item ? "is-active" : ""} onClick={() => selectTab(item)}><Icon name={item} /><span>{{ review: "Review", files: "文件", agent: "Agent", comments: "评论" }[item]}</span></button>)}</nav>{workspaceCatalog ? <WorkspacePicker catalog={workspaceCatalog} currentRoot={bootstrap.workspace.root} onSelect={selectWorkspace} onRefresh={refreshWorkspaces} onClose={() => setWorkspaceCatalog(null)} onDisconnect={disconnect} /> : null}{toast ? <div className="toast">{toast}</div> : null}</main>;
}
