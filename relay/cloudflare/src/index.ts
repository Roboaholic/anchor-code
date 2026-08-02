import {
  isRelayFrame,
  REMOTE_TRANSPORT_MAX_FRAME_BYTES,
  REMOTE_TRANSPORT_VERSION,
  type RelayErrorFrame,
  type RelayPeerFrame,
  type RelayRole,
} from "@anchor-code/remote-transport/v1";

interface Env {
  RELAY_ROOMS: DurableObjectNamespace;
}

interface PeerAttachment {
  role: RelayRole;
  peerId: string;
  rateWindowStartedAt: number;
  rateCount: number;
  pending: boolean;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function relayError(code: string, message: string, retryable: boolean): RelayErrorFrame {
  return { v: REMOTE_TRANSPORT_VERSION, type: "relay-error", code, message, retryable };
}

async function ticketHash(ticket: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ticket));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function deviceTicket(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pairingKey(expiresAt: string): string {
  return `pairing:${expiresAt}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ ok: true, service: "anchor-code-relay", protocolVersion: 1 });
    }
    if (url.pathname !== "/relay" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: { code: "not_found", message: "Route not found" } }, 404);
    }
    const roomId = url.searchParams.get("room") ?? "";
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(roomId)) {
      return json({ error: { code: "invalid_room", message: "Invalid room id" } }, 400);
    }
    const id = env.RELAY_ROOMS.idFromName(roomId);
    return env.RELAY_ROOMS.get(id).fetch(request);
  },
} satisfies ExportedHandler<Env>;

export class RelayRoom implements DurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    _env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    const peerId = url.searchParams.get("peer") ?? "";
    const ticket = url.searchParams.get("ticket") ?? "";
    const mode = url.searchParams.get("mode") ?? "legacy";
    const expiresAt = url.searchParams.get("expires") ?? "";
    if ((role !== "host" && role !== "guest") || !/^[a-zA-Z0-9_-]{3,128}$/.test(peerId) || ticket.length < 16) {
      return json({ error: { code: "invalid_handshake", message: "Invalid relay handshake" } }, 400);
    }

    const suppliedHash = await ticketHash(ticket);
    const storedHash = await this.ctx.storage.get<string>("ticketHash");
    let pairingPending = false;
    if (role === "host") {
      if (storedHash && storedHash !== suppliedHash) {
        return json({ error: { code: "unauthorized", message: "Invalid room ticket" } }, 403);
      }
      if (!storedHash) await this.ctx.storage.put("ticketHash", suppliedHash);
      const expiry = Date.parse(expiresAt);
      if (expiresAt && expiry > Date.now() && expiry <= Date.now() + 10 * 60_000) {
        await this.ctx.storage.put(pairingKey(expiresAt), false);
        const pairings = await this.ctx.storage.list<boolean>({ prefix: "pairing:" });
        const expired = [...pairings.keys()].filter((key) => Date.parse(key.slice("pairing:".length)) <= Date.now());
        if (expired.length) await this.ctx.storage.delete(expired);
      }
    } else {
      if (this.ctx.getWebSockets("host").length === 0) {
        return json({ error: { code: "host_offline", message: "Anchor Code PC is offline" } }, 503);
      }
      if (mode === "device") {
        const deviceHash = await this.ctx.storage.get<string>(`device:${peerId}`);
        if (!deviceHash || deviceHash !== suppliedHash) {
          return json({ error: { code: "revoked", message: "Device credential is invalid or revoked" } }, 403);
        }
      } else if (mode === "pair") {
        const pairingUsed = await this.ctx.storage.get<boolean>(pairingKey(expiresAt));
        if (!storedHash || storedHash !== suppliedHash || pairingUsed !== false ||
          Date.parse(expiresAt) <= Date.now()) {
          return json({ error: { code: "pairing_expired", message: "Pairing code is expired or already used" } }, 403);
        }
        pairingPending = true;
        await this.ctx.storage.put(pairingKey(expiresAt), true);
      } else {
        return json({ error: { code: "invalid_mode", message: "Pair or device mode is required" } }, 400);
      }
    }

    if (role === "guest" && this.ctx.getWebSockets("guest").length >= 8) {
      return json({ error: { code: "room_full", message: "Too many devices in this room" } }, 429);
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: PeerAttachment = {
      role,
      peerId,
      rateWindowStartedAt: Date.now(),
      rateCount: 0,
      pending: pairingPending,
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, [role, `peer:${peerId}`]);

    if (role === "host") {
      for (const existing of this.ctx.getWebSockets("host")) {
        if (existing !== server) existing.close(4001, "Host replaced");
      }
      for (const guest of this.ctx.getWebSockets("guest")) {
        const guestAttachment = guest.deserializeAttachment() as PeerAttachment | null;
        if (guestAttachment?.pending) {
          this.send(server, {
            v: REMOTE_TRANSPORT_VERSION,
            type: "pairing-request",
            peerId: guestAttachment.peerId,
          });
        } else {
          this.notify(server, guest, "online");
        }
      }
      await this.sendDevices(server);
    } else {
      for (const existing of this.ctx.getWebSockets(`peer:${peerId}`)) {
        if (existing !== server) existing.close(4001, "Peer replaced");
      }
      const host = this.ctx.getWebSockets("host")[0];
      if (host) {
        if (pairingPending) {
          this.send(host, {
            v: REMOTE_TRANSPORT_VERSION,
            type: "pairing-request",
            peerId,
          });
        } else {
          this.notify(host, server, "online");
        }
        this.notify(server, host, "online");
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = socket.deserializeAttachment() as PeerAttachment | null;
    if (!attachment || typeof message !== "string" || new TextEncoder().encode(message).byteLength > REMOTE_TRANSPORT_MAX_FRAME_BYTES) {
      this.send(socket, relayError("invalid_frame", "Invalid or oversized relay frame", false));
      return;
    }
    const now = Date.now();
    if (now - attachment.rateWindowStartedAt >= 60_000) {
      attachment.rateWindowStartedAt = now;
      attachment.rateCount = 0;
    }
    attachment.rateCount += 1;
    socket.serializeAttachment(attachment);
    if (attachment.rateCount > 1_200) {
      this.send(socket, relayError("rate_limited", "Relay message rate exceeded", true));
      socket.close(4008, "Rate limited");
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(message);
    } catch {
      this.send(socket, relayError("invalid_json", "Relay frame must be JSON", false));
      return;
    }
    if (!isRelayFrame(frame) || frame.type === "hello" || frame.type === "peer" ||
      frame.type === "relay-error" || frame.type === "credential" || frame.type === "devices" ||
      frame.type === "pairing-request") return;
    if (frame.type === "control") {
      if (attachment.role === "host" && frame.action === "approve") {
        const target = this.ctx.getWebSockets("guest").find((candidate) => {
          const candidateAttachment = candidate.deserializeAttachment() as PeerAttachment | null;
          return candidateAttachment?.peerId === frame.peerId && candidateAttachment.pending;
        });
        if (target) {
          const targetAttachment = target.deserializeAttachment() as PeerAttachment;
          const credential = deviceTicket();
          await this.ctx.storage.put(`device:${frame.peerId}`, await ticketHash(credential));
          targetAttachment.pending = false;
          target.serializeAttachment(targetAttachment);
          this.send(target, {
            v: REMOTE_TRANSPORT_VERSION,
            type: "credential",
            peerId: frame.peerId,
            ticket: credential,
          });
          this.notify(socket, target, "online");
        }
        await this.sendDevices(socket);
      } else if (attachment.role === "host" && frame.action === "revoke") {
        await this.ctx.storage.delete(`device:${frame.peerId}`);
        for (const target of this.ctx.getWebSockets("guest")) {
          const targetAttachment = target.deserializeAttachment() as PeerAttachment | null;
          if (targetAttachment?.peerId === frame.peerId) {
            target.close(4003, "Device revoked");
          }
        }
        await this.sendDevices(socket);
      }
      return;
    }
    if (frame.from !== attachment.peerId) {
      this.send(socket, relayError("invalid_sender", "Frame sender does not match connection", false));
      return;
    }
    if (attachment.role === "guest") {
      if (attachment.pending) {
        this.send(socket, relayError("pairing_pending", "Waiting for approval on Anchor Code PC", true));
        return;
      }
      const credential = await this.ctx.storage.get<string>(`device:${attachment.peerId}`);
      if (!credential) {
        this.send(socket, relayError("revoked", "Device credential is revoked", false));
        socket.close(4003, "Device revoked");
        return;
      }
      const host = this.ctx.getWebSockets("host")[0];
      if (host) this.send(host, frame);
      else this.send(socket, relayError("host_offline", "Anchor Code PC is offline", true));
      return;
    }
    if (frame.to) {
      const target = this.ctx.getWebSockets(`peer:${frame.to}`)[0];
      if (target) this.send(target, frame);
      return;
    }
    for (const guest of this.ctx.getWebSockets("guest")) this.send(guest, frame);
  }

  webSocketClose(socket: WebSocket): void {
    const attachment = socket.deserializeAttachment() as PeerAttachment | null;
    if (!attachment) return;
    if (attachment.role === "host") {
      for (const guest of this.ctx.getWebSockets("guest")) this.notify(guest, socket, "offline");
    } else {
      const host = this.ctx.getWebSockets("host")[0];
      if (host) this.notify(host, socket, "offline");
    }
  }

  webSocketError(socket: WebSocket): void {
    socket.close(1011, "Relay socket error");
  }

  private send(socket: WebSocket, value: unknown): void {
    try {
      socket.send(JSON.stringify(value));
    } catch {
      // The peer disconnected between lookup and send.
    }
  }

  private notify(target: WebSocket, peer: WebSocket, state: "online" | "offline"): void {
    const attachment = peer.deserializeAttachment() as PeerAttachment | null;
    if (!attachment) return;
    const frame: RelayPeerFrame = {
      v: REMOTE_TRANSPORT_VERSION,
      type: "peer",
      state,
      peerId: attachment.peerId,
      role: attachment.role,
    };
    this.send(target, frame);
  }

  private async sendDevices(target: WebSocket): Promise<void> {
    const stored = await this.ctx.storage.list<string>({ prefix: "device:" });
    this.send(target, {
      v: REMOTE_TRANSPORT_VERSION,
      type: "devices",
      peerIds: [...stored.keys()].map((key) => key.slice("device:".length)).sort(),
    });
  }
}
