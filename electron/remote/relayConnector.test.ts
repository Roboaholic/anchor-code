import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { LocalRelayServer } from "../../relay/local/localRelayServer.js";
import type { RemoteRequestHandler } from "../application/remoteRequestHandler.js";
import {
  isRelayFrame,
  REMOTE_TRANSPORT_VERSION,
  type RemoteTransportResponse,
} from "../../contracts/remote-transport/v1/index.js";
import { RelayConnector } from "./relayConnector.js";
import { openRelayPayload, sealRelayPayload } from "./sessionCrypto.js";

const config = {
  enabled: true,
  url: "",
  roomId: "room-test",
  hostPeerId: "pc-test",
  ticket: "ticket-test",
  secret: "secret-test",
};

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("RelayConnector", () => {
  const servers: LocalRelayServer[] = [];
  const connectors: RelayConnector[] = [];

  afterEach(async () => {
    for (const connector of connectors) connector.stop();
    for (const server of servers) await server.stop();
  });

  it("executes an encrypted transport request without exposing its body to the relay", async () => {
    const relay = new LocalRelayServer();
    servers.push(relay);
    const url = await relay.start();
    const handler = {
      async handle(request: { path: string }) {
        return { status: 200, body: { ok: true, path: request.path, private: "source-code" } };
      },
    } as unknown as RemoteRequestHandler;
    const connector = new RelayConnector(handler);
    connectors.push(connector);
    connector.start({ ...config, url });
    await waitFor(() => connector.info().state === "online");

    const socketUrl = new URL(`${url.replace(/^http/, "ws")}/relay`);
    socketUrl.searchParams.set("room", config.roomId);
    socketUrl.searchParams.set("role", "guest");
    socketUrl.searchParams.set("peer", "phone-test");
    socketUrl.searchParams.set("ticket", config.ticket);
    const socket = new WebSocket(socketUrl);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const request = {
      v: REMOTE_TRANSPORT_VERSION,
      type: "request" as const,
      requestId: "request-one",
      method: "GET" as const,
      path: "/api/v1/health",
    };
    const sealed = sealRelayPayload({
      roomId: config.roomId,
      secret: config.secret,
      sessionId: "mobile-session",
      sequence: 1,
      from: "phone-test",
      to: config.hostPeerId,
      payload: request,
    });
    expect(JSON.stringify(sealed)).not.toContain("/api/v1/health");
    socket.send(JSON.stringify(sealed));

    const responseFrame = await new Promise<ReturnType<typeof sealRelayPayload>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("response timed out")), 2_000);
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as unknown;
        if (isRelayFrame(frame) && frame.type === "sealed") {
          clearTimeout(timer);
          resolve(frame);
        }
      });
    });
    const response = openRelayPayload<RemoteTransportResponse>({
      roomId: config.roomId,
      secret: config.secret,
      frame: responseFrame,
    });
    expect(response).toMatchObject({
      requestId: "request-one",
      status: 200,
      body: { ok: true, path: "/api/v1/health", private: "source-code" },
    });
    socket.close();
  });

  it("keeps every unexpired pairing code valid across host reconnects", async () => {
    const relay = new LocalRelayServer();
    servers.push(relay);
    const url = await relay.start();
    const base = `${url.replace(/^http/, "ws")}/relay`;
    const expiresOne = new Date(Date.now() + 4 * 60_000).toISOString();
    const expiresTwo = new Date(Date.now() + 5 * 60_000).toISOString();
    const hostUrl = (expires: string) => `${base}?${new URLSearchParams({
      room: "room-multiple-pairings",
      role: "host",
      peer: "pc-multiple-pairings",
      ticket: "ticket-multiple-pairings",
      expires,
    })}`;
    const open = (socket: WebSocket) => new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const firstHost = new WebSocket(hostUrl(expiresOne));
    await open(firstHost);
    const secondHost = new WebSocket(hostUrl(expiresTwo));
    await open(secondHost);
    const guestUrl = (peer: string, expires: string) => `${base}?${new URLSearchParams({
      room: "room-multiple-pairings",
      role: "guest",
      peer,
      ticket: "ticket-multiple-pairings",
      mode: "pair",
      expires,
    })}`;
    const firstGuest = new WebSocket(guestUrl("phone-first-code", expiresOne));
    const secondGuest = new WebSocket(guestUrl("phone-second-code", expiresTwo));
    await Promise.all([open(firstGuest), open(secondGuest)]);
    firstGuest.close();
    secondGuest.close();
    secondHost.close();
    firstHost.close();
  });

  it("blocks pending devices and closes an approved connection after revoke", async () => {
    const relay = new LocalRelayServer();
    servers.push(relay);
    const url = await relay.start();
    const handler = {
      handle: vi.fn(async () => ({ status: 200, body: { ok: true } })),
    } as unknown as RemoteRequestHandler;
    const connector = new RelayConnector(handler);
    connectors.push(connector);
    connector.start({ ...config, url });
    await waitFor(() => connector.info().state === "online");
    const pairing = connector.info().pairing!;

    const guestUrl = new URL(`${url.replace(/^http/, "ws")}/relay`);
    guestUrl.searchParams.set("room", config.roomId);
    guestUrl.searchParams.set("role", "guest");
    guestUrl.searchParams.set("peer", "phone-pending");
    guestUrl.searchParams.set("ticket", config.ticket);
    guestUrl.searchParams.set("mode", "pair");
    guestUrl.searchParams.set("expires", pairing.expiresAt);
    const socket = new WebSocket(guestUrl);
    const received: unknown[] = [];
    socket.on("message", (raw) => received.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    await waitFor(() => connector.info().pendingDevices.includes("phone-pending"));

    const request = (requestId: string, sequence: number) => sealRelayPayload({
      roomId: config.roomId,
      secret: config.secret,
      sessionId: "pending-mobile-session",
      sequence,
      from: "phone-pending",
      to: config.hostPeerId,
      payload: {
        v: REMOTE_TRANSPORT_VERSION,
        type: "request" as const,
        requestId,
        method: "GET" as const,
        path: "/api/v1/health",
      },
    });
    socket.send(JSON.stringify(request("before-approval", 1)));
    await waitFor(() => received.some((frame) =>
      isRelayFrame(frame) && frame.type === "relay-error" && frame.code === "pairing_pending"));
    expect(handler.handle).not.toHaveBeenCalled();

    connector.approveDevice("phone-pending");
    await waitFor(() => received.some((frame) => isRelayFrame(frame) && frame.type === "credential"));
    socket.send(JSON.stringify(request("after-approval", 2)));
    await waitFor(() => received.some((frame) => isRelayFrame(frame) && frame.type === "sealed"));
    expect(handler.handle).toHaveBeenCalledTimes(1);

    const closed = new Promise<number>((resolve) => {
      socket.once("close", (code) => resolve(code));
    });
    connector.revokeDevice("phone-pending");
    await expect(closed).resolves.toBe(4003);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect(handler.handle).toHaveBeenCalledTimes(1);
  });
});
