import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  isRelayFrame,
  REMOTE_TRANSPORT_MAX_FRAME_BYTES,
  REMOTE_TRANSPORT_VERSION,
  type RelayErrorFrame,
  type RelayPeerFrame,
  type RelayRole,
} from "../../contracts/remote-transport/v1/index.js";

interface Peer {
  socket: WebSocket;
  peerId: string;
  role: RelayRole;
  pending: boolean;
}

interface Room {
  ticket: string;
  host: Peer | null;
  guests: Map<string, Peer>;
  devices: Map<string, string>;
  pairings: Map<string, boolean>;
}

function send(socket: WebSocket, value: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(value));
}

function relayError(code: string, message: string, retryable: boolean): RelayErrorFrame {
  return { v: REMOTE_TRANSPORT_VERSION, type: "relay-error", code, message, retryable };
}

export class LocalRelayServer {
  private readonly server = http.createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, service: "anchor-relay-local" }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  private readonly sockets = new WebSocketServer({
    noServer: true,
    maxPayload: REMOTE_TRANSPORT_MAX_FRAME_BYTES,
  });
  private readonly rooms = new Map<string, Room>();

  constructor() {
    this.server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://relay.local");
      if (url.pathname !== "/relay") {
        socket.destroy();
        return;
      }
      const roomId = url.searchParams.get("room") ?? "";
      const role = url.searchParams.get("role");
      const peerId = url.searchParams.get("peer") ?? "";
      const ticket = url.searchParams.get("ticket") ?? "";
      const mode = url.searchParams.get("mode") ?? "legacy";
      const expiresAt = url.searchParams.get("expires") ?? "";
      if (!roomId || !peerId || !ticket || (role !== "host" && role !== "guest")) {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }
      const existing = this.rooms.get(roomId);
      let pairingPending = false;
      if (role === "guest") {
        const pairingAllowed = mode === "pair" && existing?.ticket === ticket &&
          existing.pairings.get(expiresAt) === false && Date.parse(expiresAt) > Date.now();
        const deviceAllowed = mode === "device" && existing?.devices.get(peerId) === ticket;
        const legacyAllowed = mode === "legacy" && existing?.ticket === ticket;
        if (!existing?.host || (!pairingAllowed && !deviceAllowed && !legacyAllowed)) {
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }
        if (pairingAllowed) {
          existing.pairings.set(expiresAt, true);
          pairingPending = true;
        }
      }
      if (role === "host" && existing && existing.ticket !== ticket) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      this.sockets.handleUpgrade(request, socket, head, (webSocket) => {
        this.accept(webSocket, roomId, role, peerId, ticket, expiresAt, pairingPending);
      });
    });
  }

  async start(port = 0): Promise<string> {
    if (!this.server.listening) {
      await new Promise<void>((resolve, reject) => {
        this.server.once("error", reject);
        this.server.listen(port, "127.0.0.1", () => resolve());
      });
    }
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    for (const client of this.sockets.clients) client.terminate();
    this.rooms.clear();
    if (this.server.listening) {
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }
  }

  private accept(
    socket: WebSocket,
    roomId: string,
    role: RelayRole,
    peerId: string,
    ticket: string,
    expiresAt: string,
    pairingPending: boolean,
  ): void {
    const room = this.rooms.get(roomId) ?? {
      ticket,
      host: null,
      guests: new Map<string, Peer>(),
      devices: new Map<string, string>(),
      pairings: new Map<string, boolean>(),
    };
    this.rooms.set(roomId, room);
    const peer: Peer = { socket, peerId, role, pending: pairingPending };
    if (role === "host") {
      if (expiresAt && Date.parse(expiresAt) > Date.now()) {
        room.pairings.set(expiresAt, false);
        for (const expiry of room.pairings.keys()) {
          if (Date.parse(expiry) <= Date.now()) room.pairings.delete(expiry);
        }
      }
      room.host?.socket.close(4001, "Host replaced");
      room.host = peer;
      send(socket, {
        v: REMOTE_TRANSPORT_VERSION,
        type: "devices",
        peerIds: [...room.devices.keys()],
      });
      for (const guest of room.guests.values()) {
        if (guest.pending) {
          send(peer.socket, {
            v: REMOTE_TRANSPORT_VERSION,
            type: "pairing-request",
            peerId: guest.peerId,
          });
        } else {
          this.notify(peer.socket, guest, "online");
        }
      }
    } else {
      room.guests.get(peerId)?.socket.close(4001, "Peer replaced");
      room.guests.set(peerId, peer);
      if (room.host) {
        if (pairingPending) {
          send(room.host.socket, {
            v: REMOTE_TRANSPORT_VERSION,
            type: "pairing-request",
            peerId,
          });
        } else {
          this.notify(room.host.socket, peer, "online");
        }
        this.notify(peer.socket, room.host, "online");
      }
    }

    socket.on("message", (raw) => {
      const text = raw.toString();
      if (Buffer.byteLength(text) > REMOTE_TRANSPORT_MAX_FRAME_BYTES) {
        send(socket, relayError("frame_too_large", "Relay frame is too large", false));
        socket.close(1009);
        return;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(text);
      } catch {
        send(socket, relayError("invalid_json", "Relay frame must be JSON", false));
        return;
      }
      if (!isRelayFrame(frame) || frame.type === "relay-error" || frame.type === "peer" ||
        frame.type === "credential" || frame.type === "devices" ||
        frame.type === "pairing-request") return;
      if (frame.type === "hello") return;
      if (frame.type === "control") {
        if (role === "host" && frame.action === "approve") {
          const target = room.guests.get(frame.peerId);
          if (target?.pending) {
            const credential = randomBytes(32).toString("base64url");
            target.pending = false;
            room.devices.set(frame.peerId, credential);
            send(target.socket, {
              v: REMOTE_TRANSPORT_VERSION,
              type: "credential",
              peerId: frame.peerId,
              ticket: credential,
            });
            this.notify(socket, target, "online");
          }
        } else if (role === "host" && frame.action === "revoke") {
          room.devices.delete(frame.peerId);
          room.guests.get(frame.peerId)?.socket.close(4003, "Device revoked");
        }
        if (role === "host") {
          send(socket, {
            v: REMOTE_TRANSPORT_VERSION,
            type: "devices",
            peerIds: [...room.devices.keys()],
          });
        }
        return;
      }
      if (peer.pending) {
        send(socket, relayError("pairing_pending", "Waiting for approval on Anchor Code PC", true));
        return;
      }
      if (frame.from !== peerId) {
        send(socket, relayError("invalid_sender", "Frame sender does not match connection", false));
        return;
      }
      if (role === "guest") {
        if (room.host && (!frame.to || frame.to === room.host.peerId)) send(room.host.socket, frame);
        else send(socket, relayError("host_offline", "Anchor Code PC is offline", true));
        return;
      }
      if (frame.to) {
        const target = room.guests.get(frame.to);
        if (target) send(target.socket, frame);
        return;
      }
      for (const guest of room.guests.values()) send(guest.socket, frame);
    });

    socket.on("close", () => {
      if (role === "host" && room.host?.socket === socket) {
        room.host = null;
        for (const guest of room.guests.values()) this.notify(guest.socket, peer, "offline");
      } else if (role === "guest" && room.guests.get(peerId)?.socket === socket) {
        room.guests.delete(peerId);
        if (room.host) this.notify(room.host.socket, peer, "offline");
      }
    });
  }

  private notify(socket: WebSocket, peer: Peer, state: "online" | "offline"): void {
    const frame: RelayPeerFrame = {
      v: REMOTE_TRANSPORT_VERSION,
      type: "peer",
      state,
      peerId: peer.peerId,
      role: peer.role,
    };
    send(socket, frame);
  }
}
