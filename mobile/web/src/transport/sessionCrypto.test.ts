import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  openRelayPayload as openInBrowser,
  sealRelayPayload as sealInBrowser,
} from "./sessionCrypto";
import {
  openRelayPayload as openOnDesktop,
  sealRelayPayload as sealOnDesktop,
} from "../../../../electron/remote/sessionCrypto.js";
import { RelayTransport } from "./relayTransport";
import { RelayConnector } from "../../../../electron/remote/relayConnector.js";
import type { RemoteRequestHandler } from "../../../../electron/application/remoteRequestHandler.js";
import { LocalRelayServer } from "../../../../relay/local/localRelayServer.js";

const input = {
  roomId: "cross-platform-room",
  secret: "cross-platform-secret",
  sessionId: "cross-platform-session",
  sequence: 42,
  from: "mobile",
  to: "desktop",
  payload: { text: "source, prompt, and terminal output", unicode: "连接正常" },
};

describe("cross-platform relay crypto", () => {
  const servers: LocalRelayServer[] = [];
  const connectors: RelayConnector[] = [];

  afterEach(async () => {
    for (const connector of connectors) connector.stop();
    for (const server of servers) await server.stop();
  });

  it("opens browser ciphertext on the desktop", async () => {
    const frame = await sealInBrowser(input);
    expect(openOnDesktop({ roomId: input.roomId, secret: input.secret, frame }))
      .toEqual(input.payload);
  });

  it("opens desktop ciphertext in the browser implementation", async () => {
    const frame = sealOnDesktop(input);
    await expect(openInBrowser({ roomId: input.roomId, secret: input.secret, frame }))
      .resolves.toEqual(input.payload);
  });

  it("carries a Mobile transport request through the relay into the PC handler", async () => {
    Object.assign(globalThis, { WebSocket, window: globalThis });
    const relay = new LocalRelayServer();
    servers.push(relay);
    const relayUrl = await relay.start();
    const handler = {
      async handle(request: { path: string }) {
        return { status: 200, body: { ok: true, executedBy: "pc", path: request.path } };
      },
    } as unknown as RemoteRequestHandler;
    const connector = new RelayConnector(handler);
    connectors.push(connector);
    connector.start({
      enabled: true,
      url: relayUrl,
      roomId: "room-mobile-integration",
      hostPeerId: "pc-integration",
      ticket: "ticket-mobile-integration",
      secret: "secret-mobile-integration",
    });
    const deadline = Date.now() + 2_000;
    while (connector.info().state !== "online") {
      if (Date.now() > deadline) throw new Error("PC connector did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const expiresAt = connector.info().pairing!.expiresAt;
    const connection = {
      mode: "relay",
      relayUrl,
      roomId: "room-mobile-integration",
      hostPeerId: "pc-integration",
      peerId: "mobile-integration",
      ticket: "ticket-mobile-integration",
      secret: "secret-mobile-integration",
      expiresAt,
      paired: false,
    } as const;
    const transport = new RelayTransport({ ...connection });
    const health = transport.request("/api/v1/health", { timeoutMs: 2_000 });
    const approvalDeadline = Date.now() + 1_000;
    while (!connector.info().pendingDevices.includes("mobile-integration")) {
      if (Date.now() > approvalDeadline) throw new Error("pairing request did not reach the PC");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    connector.approveDevice("mobile-integration");
    await expect(health).resolves.toEqual({
      ok: true,
      executedBy: "pc",
      path: "/api/v1/health",
    });

    expect(connector.info().devices).toEqual([
      { peerId: "mobile-integration", online: true },
    ]);
    const replayedQr = new RelayTransport({
      ...connection,
      peerId: "mobile-replayed-qr",
    });
    await expect(replayedQr.request("/api/v1/health", { timeoutMs: 500 }))
      .rejects.toThrow();

    connector.revokeDevice("mobile-integration");
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(transport.request("/api/v1/health", { timeoutMs: 500 }))
      .rejects.toThrow();
  });
});
