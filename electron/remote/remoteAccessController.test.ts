import { describe, expect, it, vi } from "vitest";
import type { RemoteRelayConfig } from "../settings.js";
import type { RelayConnectorInfo } from "./relayConnector.js";
import { RemoteAccessController, type RemoteRelay } from "./remoteAccessController.js";

const identity: RemoteRelayConfig = {
  enabled: false,
  url: "https://relay.invalid",
  roomId: "room-1",
  hostPeerId: "pc-1",
  ticket: "t",
  secret: "s",
};

function fakeRelay() {
  let config: RemoteRelayConfig | null = null;
  const info = (): RelayConnectorInfo => ({
    enabled: config?.enabled === true,
    state: config?.enabled ? "connecting" : "disabled",
    url: config?.url ?? "",
    roomId: config?.roomId ?? "",
    hostPeerId: config?.hostPeerId ?? "",
    connectedGuests: 0,
    devices: [],
    pendingDevices: [],
  });
  const relay: RemoteRelay = {
    start: vi.fn((c: RemoteRelayConfig) => { config = c; return info(); }),
    stop: vi.fn(() => { if (config) config = { ...config, enabled: false }; }),
    info,
    revokeDevice: vi.fn(),
    approveDevice: vi.fn(),
  };
  return relay;
}

function setup() {
  const relay = fakeRelay();
  const dispose = vi.fn();
  const createRelay = vi.fn(() => ({ relay, dispose }));
  const loadRelayIdentity = vi.fn(async () => identity);
  const controller = new RemoteAccessController({ createRelay, loadRelayIdentity });
  return { controller, relay, dispose, createRelay, loadRelayIdentity };
}

describe("RemoteAccessController (experimental Mobile access)", () => {
  it("does not create or start the relay until the user enables it", () => {
    const { controller, createRelay, loadRelayIdentity } = setup();
    const info = controller.getInfo();
    expect(info.enabled).toBe(false);
    expect(info.relay.state).toBe("disabled");
    expect(info.relay.pairing).toBeUndefined();
    expect(createRelay).not.toHaveBeenCalled();
    expect(loadRelayIdentity).not.toHaveBeenCalled();
    expect(controller.relayCreated).toBe(false);
  });

  it("starts the relay only on an explicit enable and stops it on disable", async () => {
    const { controller, relay, createRelay } = setup();
    const on = await controller.setEnabled(true);
    expect(createRelay).toHaveBeenCalledTimes(1);
    expect(relay.start).toHaveBeenCalledWith({ ...identity, enabled: true });
    expect(on.enabled).toBe(true);
    expect(on.relay.state).toBe("connecting");

    const off = await controller.setEnabled(false);
    expect(relay.stop).toHaveBeenCalled();
    expect(off.enabled).toBe(false);

    await controller.setEnabled(true);
    expect(createRelay).toHaveBeenCalledTimes(1);
  });

  it("disable before any enable never builds the relay", async () => {
    const { controller, createRelay } = setup();
    await controller.setEnabled(false);
    expect(createRelay).not.toHaveBeenCalled();
  });

  it("rejects device actions while off and disposes the relay", async () => {
    const { controller, dispose, relay } = setup();
    expect(() => controller.approveDevice("p")).toThrow(/off/);
    await controller.setEnabled(true);
    controller.approveDevice("p");
    expect(relay.approveDevice).toHaveBeenCalledWith("p");
    controller.dispose();
    expect(dispose).toHaveBeenCalled();
    expect(controller.getInfo().enabled).toBe(false);
  });
});
