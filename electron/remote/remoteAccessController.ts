import type { RemoteRelayConfig } from "../settings.js";
import type { RelayConnectorInfo } from "./relayConnector.js";

/** Minimal relay surface the controller drives (RelayConnector implements it). */
export interface RemoteRelay {
  start(config: RemoteRelayConfig): RelayConnectorInfo;
  stop(): void;
  info(): RelayConnectorInfo;
  revokeDevice(peerId: string): void;
  approveDevice(peerId: string): void;
}

export interface RemoteAccessInfo {
  enabled: boolean;
  relay: RelayConnectorInfo;
}

export interface RemoteAccessControllerOptions {
  /** Lazily builds the relay (and its request handler) on first explicit enable. */
  createRelay: () => { relay: RemoteRelay; dispose: () => void };
  /** Stable relay identity; always returned with enabled=false. */
  loadRelayIdentity: () => Promise<RemoteRelayConfig>;
}

const DISABLED_RELAY_INFO: RelayConnectorInfo = {
  enabled: false,
  state: "disabled",
  url: "",
  roomId: "",
  hostPeerId: "",
  connectedGuests: 0,
  devices: [],
  pendingDevices: [],
};

/**
 * Experimental Mobile access, session-only.
 *
 * - Nothing is created or connected at app launch, whatever the settings file
 *   says. The relay connector is built only the first time the user turns
 *   Mobile access on from Settings → Experimental.
 * - The on/off state lives in memory for the current session and is never
 *   persisted, so a restart always comes back with the relay off.
 */
export class RemoteAccessController {
  private enabled = false;
  private relay: RemoteRelay | null = null;
  private disposeRelay: (() => void) | null = null;

  constructor(private readonly opts: RemoteAccessControllerOptions) {}

  /** True once the relay has been constructed (only after an explicit enable). */
  get relayCreated(): boolean {
    return this.relay !== null;
  }

  getInfo(): RemoteAccessInfo {
    return {
      enabled: this.enabled,
      relay: this.relay ? this.relay.info() : { ...DISABLED_RELAY_INFO },
    };
  }

  async setEnabled(enabled: boolean): Promise<RemoteAccessInfo> {
    if (!enabled) {
      this.enabled = false;
      this.relay?.stop();
      return this.getInfo();
    }
    const identity = await this.opts.loadRelayIdentity();
    if (!this.relay) {
      const created = this.opts.createRelay();
      this.relay = created.relay;
      this.disposeRelay = created.dispose;
    }
    this.enabled = true;
    this.relay.start({ ...identity, enabled: true });
    return this.getInfo();
  }

  approveDevice(peerId: string): RemoteAccessInfo {
    if (!this.relay) throw new Error("Mobile access is off");
    this.relay.approveDevice(peerId);
    return this.getInfo();
  }

  revokeDevice(peerId: string): RemoteAccessInfo {
    if (!this.relay) throw new Error("Mobile access is off");
    this.relay.revokeDevice(peerId);
    return this.getInfo();
  }

  dispose(): void {
    this.enabled = false;
    this.relay?.stop();
    this.disposeRelay?.();
    this.relay = null;
    this.disposeRelay = null;
  }
}
