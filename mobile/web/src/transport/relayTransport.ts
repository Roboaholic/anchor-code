import {
  isRelayFrame,
  isRemoteTransportResponse,
  REMOTE_TRANSPORT_MAX_FRAME_BYTES,
  REMOTE_TRANSPORT_VERSION,
  type RelayHelloFrame,
  type RemoteTransportMethod,
  type RemoteTransportRequest,
  type RemoteTransportResponse,
} from "@anchor-code/remote-transport/v1";
import { openRelayPayload, sealRelayPayload } from "./sessionCrypto";
import {
  RemoteApiError,
  type RelayConnection,
  type RemoteTransport,
  type RequestOptions,
} from "./types";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: number;
  abort?: () => void;
}

function webSocketUrl(value: string, connection: RelayConnection): string {
  const url = new URL(value);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("中继地址必须使用 HTTPS 或 WSS");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/relay`;
  url.searchParams.set("room", connection.roomId);
  url.searchParams.set("role", "guest");
  url.searchParams.set("peer", connection.peerId);
  url.searchParams.set("ticket", connection.ticket);
  url.searchParams.set("mode", connection.paired ? "device" : "pair");
  if (!connection.paired && connection.expiresAt) {
    url.searchParams.set("expires", connection.expiresAt);
  }
  return url.toString();
}

function requestId(): string {
  return crypto.randomUUID?.() ?? `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export class RelayTransport implements RemoteTransport {
  private socket: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private sessionId = requestId();
  private sequence = 0;
  private lastIncoming = new Map<string, number>();
  private pending = new Map<string, PendingRequest>();
  private pairingResolve: ((socket: WebSocket) => void) | null = null;
  private pairingReject: ((reason: unknown) => void) | null = null;

  constructor(private readonly connection: RelayConnection) {}

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, signal, ...init } = options;
    const method = (init.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "POST" && method !== "PATCH" && method !== "DELETE") {
      throw new Error(`不支持的请求方法: ${method}`);
    }
    const url = new URL(path, "https://anchor.local");
    const id = requestId();
    const query = Object.fromEntries(url.searchParams.entries());
    let body: Record<string, unknown> | undefined;
    if (typeof init.body === "string" && init.body) {
      const parsed = JSON.parse(init.body) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("请求正文必须是对象");
      body = parsed as Record<string, unknown>;
    }
    const frame: RemoteTransportRequest = {
      v: REMOTE_TRANSPORT_VERSION,
      type: "request",
      requestId: id,
      method: method as RemoteTransportMethod,
      path: url.pathname,
      ...(Object.keys(query).length ? { query } : {}),
      ...(body ? { body } : {}),
    };
    const socket = await this.ensureConnected();
    this.sequence += 1;
    const sealed = await sealRelayPayload({
      roomId: this.connection.roomId,
      secret: this.connection.secret,
      sessionId: this.sessionId,
      sequence: this.sequence,
      from: this.connection.peerId,
      to: this.connection.hostPeerId,
      payload: frame,
    });

    return new Promise<T>((resolve, reject) => {
      const finishAbort = () => {
        this.finishPending(id);
        reject(new Error("连接已取消"));
      };
      const timer = window.setTimeout(() => {
        this.finishPending(id);
        reject(new Error("中继请求超时，请确认电脑在线且中继连接正常"));
      }, Math.max(1, timeoutMs));
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        ...(signal ? { abort: finishAbort } : {}),
      });
      signal?.addEventListener("abort", finishAbort, { once: true });
      if (signal?.aborted) finishAbort();
      else socket.send(JSON.stringify(sealed));
    });
  }

  private async ensureConnected(): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) return this.socket;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(webSocketUrl(this.connection.relayUrl, this.connection));
      this.socket = socket;
      socket.addEventListener("open", () => {
        this.sessionId = requestId();
        this.sequence = 0;
        this.lastIncoming.clear();
        const hello: RelayHelloFrame = {
          v: REMOTE_TRANSPORT_VERSION,
          type: "hello",
          role: "guest",
          roomId: this.connection.roomId,
          peerId: this.connection.peerId,
          ticket: this.connection.ticket,
        };
        socket.send(JSON.stringify(hello));
        if (this.connection.paired || !this.connection.expiresAt) resolve(socket);
        else {
          this.pairingResolve = resolve;
          this.pairingReject = reject;
        }
      }, { once: true });
      socket.addEventListener("error", () => reject(new Error("无法连接 Anchor Relay")), { once: true });
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string" && event.data.length <= REMOTE_TRANSPORT_MAX_FRAME_BYTES) {
          void this.onMessage(event.data);
        }
      });
      socket.addEventListener("close", () => {
        if (this.socket === socket) this.socket = null;
        this.pairingReject?.(new Error("配对连接已断开"));
        this.pairingResolve = null;
        this.pairingReject = null;
        for (const [id, pending] of this.pending) {
          this.finishPending(id);
          pending.reject(new Error("中继连接已断开，正在等待重新连接"));
        }
      });
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async onMessage(raw: string): Promise<void> {
    const frame = JSON.parse(raw) as unknown;
    if (!isRelayFrame(frame)) return;
    if (frame.type === "credential" && frame.peerId === this.connection.peerId) {
      this.connection.ticket = frame.ticket;
      this.connection.paired = true;
      delete this.connection.expiresAt;
      if (this.socket) this.pairingResolve?.(this.socket);
      this.pairingResolve = null;
      this.pairingReject = null;
      return;
    }
    if (frame.type === "relay-error") {
      for (const [id, pending] of this.pending) {
        this.finishPending(id);
        pending.reject(new Error(frame.message));
      }
      return;
    }
    if (frame.type !== "sealed" || frame.to !== this.connection.peerId) return;
    const replayKey = `${frame.from}:${frame.sessionId}`;
    const previous = this.lastIncoming.get(replayKey) ?? 0;
    if (frame.sequence <= previous) return;
    const response = await openRelayPayload<RemoteTransportResponse>({
      roomId: this.connection.roomId,
      secret: this.connection.secret,
      frame,
    });
    if (!isRemoteTransportResponse(response)) return;
    this.lastIncoming.set(replayKey, frame.sequence);
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    this.finishPending(response.requestId);
    if (response.status >= 200 && response.status < 300) {
      pending.resolve(response.body);
      return;
    }
    const body = response.body as { error?: { code?: string; message?: string } };
    pending.reject(new RemoteApiError(
      body.error?.message || `请求失败 (${response.status})`,
      response.status,
      body.error?.code,
    ));
  }

  private finishPending(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    window.clearTimeout(pending.timer);
    if (pending.abort) {
      // AbortSignal does not expose the original signal here; once listeners self-remove on abort.
    }
    this.pending.delete(id);
  }
}
