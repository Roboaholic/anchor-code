import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  isRelayFrame,
  isRemoteTransportRequest,
  REMOTE_TRANSPORT_MAX_FRAME_BYTES,
  REMOTE_TRANSPORT_VERSION,
  type RelayHelloFrame,
  type RelayPairingPayload,
  type RelaySealedFrame,
  type RemoteTransportResponse,
} from "../../contracts/remote-transport/v1/index.js";
import {
  fromTransportRequest,
  RemoteRequestHandler,
  remoteErrorPayload,
  remoteStatusForError,
} from "../application/remoteRequestHandler.js";
import type { RemoteRelayConfig } from "../settings.js";
import { openRelayPayload, sealRelayPayload } from "./sessionCrypto.js";

export type RelayConnectionState = "disabled" | "connecting" | "online" | "offline";

export interface RelayConnectorInfo {
  enabled: boolean;
  state: RelayConnectionState;
  url: string;
  roomId: string;
  hostPeerId: string;
  connectedGuests: number;
  devices: Array<{ peerId: string; online: boolean }>;
  pendingDevices: string[];
  error?: string;
  pairing?: RelayPairingPayload;
}

function webSocketUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("Relay address must use https, http, wss, or ws");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/relay`;
  return url.toString();
}

export class RelayConnector {
  private socket: WebSocket | null = null;
  private config: RemoteRelayConfig | null = null;
  private state: RelayConnectionState = "disabled";
  private error: string | undefined;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryAttempt = 0;
  private shouldRun = false;
  private sessionId = randomUUID();
  private sequence = 0;
  private lastIncoming = new Map<string, number>();
  private guests = new Set<string>();
  private devices = new Set<string>();
  private pendingDevices = new Set<string>();
  private pairingExpiresAt = "";

  constructor(private readonly handler: RemoteRequestHandler) {}

  private setHandlerActive(active: boolean): void {
    // Keep compatibility with lightweight handler doubles used by transport
    // tests while the real handler lazily subscribes to application events.
    this.handler.setActive?.(active);
  }

  start(config: RemoteRelayConfig): RelayConnectorInfo {
    this.stop();
    this.config = config;
    this.error = undefined;
    this.pairingExpiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    if (!config.enabled || !config.url) {
      this.state = "disabled";
      return this.info();
    }
    this.shouldRun = true;
    this.connect();
    return this.info();
  }

  stop(): void {
    this.setHandlerActive(false);
    this.shouldRun = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const current = this.socket;
    this.socket = null;
    if (current) {
      current.removeAllListeners();
      current.close();
    }
    this.guests.clear();
    this.pendingDevices.clear();
    this.state = this.config?.enabled ? "offline" : "disabled";
  }

  info(): RelayConnectorInfo {
    const config = this.config;
    const result: RelayConnectorInfo = {
      enabled: config?.enabled === true,
      state: this.state,
      url: config?.url ?? "",
      roomId: config?.roomId ?? "",
      hostPeerId: config?.hostPeerId ?? "",
      connectedGuests: this.guests.size,
      devices: [...this.devices]
        .sort()
        .map((peerId) => ({ peerId, online: this.guests.has(peerId) })),
      pendingDevices: [...this.pendingDevices].sort(),
      ...(this.error ? { error: this.error } : {}),
    };
    if (config?.enabled && config.url) {
      result.pairing = {
        v: REMOTE_TRANSPORT_VERSION,
        type: "anchor-code-relay",
        relayUrl: config.url,
        roomId: config.roomId,
        hostPeerId: config.hostPeerId,
        ticket: config.ticket,
        secret: config.secret,
        expiresAt: this.pairingExpiresAt,
      };
    }
    return result;
  }

  revokeDevice(peerId: string): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !peerId) {
      throw new Error("Relay is not connected");
    }
    socket.send(JSON.stringify({
      v: REMOTE_TRANSPORT_VERSION,
      type: "control",
      action: "revoke",
      peerId,
    }));
    this.devices.delete(peerId);
    this.guests.delete(peerId);
    this.pendingDevices.delete(peerId);
    this.setHandlerActive(this.guests.size > 0);
  }

  approveDevice(peerId: string): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !peerId) {
      throw new Error("Relay is not connected");
    }
    socket.send(JSON.stringify({
      v: REMOTE_TRANSPORT_VERSION,
      type: "control",
      action: "approve",
      peerId,
    }));
    this.pendingDevices.delete(peerId);
  }

  private connect(): void {
    const config = this.config;
    if (!this.shouldRun || !config) return;
    this.state = "connecting";
    this.sessionId = randomUUID();
    this.sequence = 0;
    this.lastIncoming.clear();
    try {
      const url = new URL(webSocketUrl(config.url));
      url.searchParams.set("room", config.roomId);
      url.searchParams.set("role", "host");
      url.searchParams.set("peer", config.hostPeerId);
      url.searchParams.set("ticket", config.ticket);
      url.searchParams.set("expires", this.pairingExpiresAt);
      const socket = new WebSocket(url, { maxPayload: REMOTE_TRANSPORT_MAX_FRAME_BYTES });
      this.socket = socket;
      socket.on("open", () => {
        if (this.socket !== socket) return;
        this.state = "online";
        this.error = undefined;
        this.retryAttempt = 0;
        const hello: RelayHelloFrame = {
          v: REMOTE_TRANSPORT_VERSION,
          type: "hello",
          role: "host",
          roomId: config.roomId,
          peerId: config.hostPeerId,
          ticket: config.ticket,
        };
        socket.send(JSON.stringify(hello));
      });
      socket.on("message", (data) => {
        void this.onMessage(data.toString()).catch((error) => {
          console.warn("[relay] message rejected:", error instanceof Error ? error.message : error);
        });
      });
      socket.on("error", (error) => {
        this.error = error.message;
      });
      socket.on("close", () => {
        if (this.socket === socket) this.socket = null;
        this.guests.clear();
        if (this.shouldRun) this.scheduleReconnect();
      });
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldRun || this.retryTimer) return;
    this.state = "offline";
    const delay = Math.min(30_000, 500 * (2 ** this.retryAttempt));
    this.retryAttempt = Math.min(this.retryAttempt + 1, 8);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay + Math.floor(Math.random() * 250));
  }

  private async onMessage(raw: string): Promise<void> {
    if (Buffer.byteLength(raw) > REMOTE_TRANSPORT_MAX_FRAME_BYTES) {
      throw new Error("Relay frame is too large");
    }
    const frame = JSON.parse(raw) as unknown;
    if (!isRelayFrame(frame)) throw new Error("Invalid relay frame");
    if (frame.type === "peer") {
      if (frame.role === "guest") {
        if (frame.state === "online") {
          this.guests.add(frame.peerId);
          this.devices.add(frame.peerId);
        }
        else this.guests.delete(frame.peerId);
        this.setHandlerActive(this.guests.size > 0);
      }
      return;
    }
    if (frame.type === "devices") {
      this.devices = new Set(frame.peerIds);
      return;
    }
    if (frame.type === "pairing-request") {
      this.pendingDevices.add(frame.peerId);
      return;
    }
    if (frame.type === "relay-error") {
      this.error = frame.message;
      return;
    }
    if (frame.type !== "sealed") return;
    const config = this.config;
    if (!config || frame.to !== config.hostPeerId) return;
    this.setHandlerActive(true);
    const replayKey = `${frame.from}:${frame.sessionId}`;
    const previous = this.lastIncoming.get(replayKey) ?? 0;
    if (frame.sequence <= previous) throw new Error("Replayed relay frame");
    const request = openRelayPayload<unknown>({ roomId: config.roomId, secret: config.secret, frame });
    if (!isRemoteTransportRequest(request)) throw new Error("Invalid encrypted request");
    this.lastIncoming.set(replayKey, frame.sequence);

    let response: RemoteTransportResponse;
    try {
      const result = await this.handler.handle(fromTransportRequest(request));
      response = {
        v: REMOTE_TRANSPORT_VERSION,
        type: "response",
        requestId: request.requestId,
        status: result.status,
        body: result.body,
      };
    } catch (error) {
      response = {
        v: REMOTE_TRANSPORT_VERSION,
        type: "response",
        requestId: request.requestId,
        status: remoteStatusForError(error),
        body: remoteErrorPayload(error, request.requestId),
      };
    }
    this.sendSealed(frame.from, response);
  }

  private sendSealed(to: string, payload: unknown): void {
    const config = this.config;
    const socket = this.socket;
    if (!config || !socket || socket.readyState !== WebSocket.OPEN) return;
    this.sequence += 1;
    const frame: RelaySealedFrame = sealRelayPayload({
      roomId: config.roomId,
      secret: config.secret,
      sessionId: this.sessionId,
      sequence: this.sequence,
      from: config.hostPeerId,
      to,
      payload,
    });
    socket.send(JSON.stringify(frame));
  }
}
