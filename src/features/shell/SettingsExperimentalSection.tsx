import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import type { RemoteAccessInfo } from "@/shared/anchor-api";
import { formatError } from "@/shared/formatError";
import { Icon } from "@/shared/Icon";
import { Switch } from "@/shared/Switch";

const OUTDATED_MAIN =
  "The desktop main process is outdated. Quit Anchor Code completely and restart it.";
const DEFAULT_RELAY_URL = "https://anchor-code-relay.anchor-code-mobile.workers.dev";

/**
 * Settings → Experimental → Mobile access (QR pairing with Anchor Mobile).
 *
 * The relay is session-only: it never starts at launch, and only connects
 * after the user flips the switch here. Restarting the app turns it off.
 */
export function SettingsExperimentalSection() {
  const [info, setInfo] = useState<RemoteAccessInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairingQr, setPairingQr] = useState<string | null>(null);
  const remote = window.anchor?.remote;
  const available = typeof remote?.update === "function";
  const enabled = info?.enabled === true;
  const state = enabled ? info?.relay?.state ?? "connecting" : "disabled";

  useEffect(() => {
    if (!remote?.getInfo) {
      setError(OUTDATED_MAIN);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      void remote.getInfo().then((next) => {
        if (!cancelled) setInfo(next);
      }).catch((err: unknown) => {
        if (!cancelled) setError(formatError(err));
      });
    };
    refresh();
    // Poll only while the relay is on so device / connection state stays fresh.
    const timer = enabled ? window.setInterval(refresh, 1_000) : null;
    return () => {
      cancelled = true;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [remote, enabled]);

  useEffect(() => {
    const pairing = info?.enabled && info.relay?.state === "online" ? info.relay.pairing : undefined;
    if (!pairing) {
      setPairingQr(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(JSON.stringify(pairing), {
      width: 800,
      margin: 4,
      errorCorrectionLevel: "M",
      // A QR code must stay dark-on-white to scan, independent of theme.
      color: { dark: "#10151b", light: "#ffffff" },
    }).then((url) => {
      if (!cancelled) setPairingQr(url);
    }).catch(() => {
      if (!cancelled) setPairingQr(null);
    });
    return () => { cancelled = true; };
  }, [info]);

  const setEnabled = useCallback(async (next: boolean) => {
    if (!remote?.update) {
      setError(OUTDATED_MAIN);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setInfo(await remote.update({ enabled: next }));
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }, [remote]);

  const deviceAction = useCallback((action: "approve" | "revoke", peerId: string) => {
    if (!remote) return;
    const run = action === "approve" ? remote.approveDevice : remote.revokeDevice;
    void run(peerId).then(setInfo).catch((err: unknown) => setError(formatError(err)));
  }, [remote]);

  const relayError = error ?? (enabled ? info?.relay?.error : undefined) ?? null;
  const pending = enabled ? info?.relay?.pendingDevices ?? [] : [];
  const devices = enabled ? info?.relay?.devices ?? [] : [];

  return (
    <section className="settings-section mobile-access" aria-label="Experimental">
      <div className="settings-experimental-note" role="note">
        <Icon name="beaker" />
        <span>
          Experimental features may change or be removed. Mobile access stays off
          at launch; turn it on here when you want to pair a phone. It turns off
          again when Anchor Code restarts.
        </span>
      </div>

      <div className="mobile-access__heading">
        <div>
          <h3 className="settings-section__title">Mobile access</h3>
          <p className="settings-section__desc muted">
            Review from Anchor Mobile through the end-to-end encrypted Anchor Relay.
          </p>
        </div>
        <span className={`mobile-access__state is-${state}`} data-testid="mobile-access-state">
          <i />{state}
        </span>
      </div>

      <div className="mobile-access__control">
        <span className="mobile-access__control-icon"><Icon name="radio-tower" /></span>
        <div className="mobile-access__control-copy">
          <b id="mobile-access-switch-label">Encrypted relay</b>
          <code>{(enabled && info?.relay?.url) || DEFAULT_RELAY_URL}</code>
        </div>
        <label className="settings-checkbox mobile-access__switch">
          <Switch
            data-testid="mobile-access-toggle"
            checked={enabled}
            disabled={busy || !available}
            aria-labelledby="mobile-access-switch-label"
            onChange={(next) => void setEnabled(next)}
          />
          <span>{busy ? (enabled ? "Turning off…" : "Connecting…") : enabled ? "On" : "Off"}</span>
        </label>
      </div>

      {relayError ? (
        <p className="settings-update-card__err mobile-access__error" role="alert">{relayError}</p>
      ) : null}

      <div className="mobile-access__layout">
        <section className="mobile-access__devices" aria-label="Paired devices">
          <div className="mobile-access__subhead">
            <div><span>Devices</span><b>Paired and pending access</b></div>
            <strong>{enabled ? info?.relay?.connectedGuests ?? 0 : 0} online</strong>
          </div>
          <div className="mobile-access__device-list">
            {pending.map((peerId) => (
              <div className="mobile-access__device is-pending" key={`pending:${peerId}`}>
                <span className="mobile-access__device-icon"><Icon name="device-mobile" /></span>
                <span className="mobile-access__device-copy"><b>New pairing request</b><code>{peerId}</code></span>
                <button type="button" className="btn btn--accent btn--small" onClick={() => deviceAction("approve", peerId)}>Approve</button>
                <button type="button" className="btn btn--small" onClick={() => deviceAction("revoke", peerId)}>Reject</button>
              </div>
            ))}
            {devices.map((device) => (
              <div className="mobile-access__device" key={device.peerId}>
                <span className="mobile-access__device-icon"><Icon name="device-mobile" /></span>
                <span className="mobile-access__device-copy"><b>{device.online ? "Online device" : "Paired device"}</b><code>{device.peerId}</code></span>
                <span className={`mobile-access__presence${device.online ? " is-online" : ""}`} />
                <button type="button" className="btn btn--small" onClick={() => deviceAction("revoke", device.peerId)}>Revoke</button>
              </div>
            ))}
            {!pending.length && !devices.length ? (
              <div className="mobile-access__empty">
                <Icon name="device-mobile" />
                <span><b>No paired devices</b><small>Turn on the relay, then scan the QR code with Anchor Mobile.</small></span>
              </div>
            ) : null}
          </div>
        </section>

        <section className="mobile-access__pairing" aria-label="Quick pairing">
          <div className="mobile-access__subhead">
            <div><span>Quick pairing</span><b>Scan with Anchor Mobile</b></div>
          </div>
          <div className={`settings-pairing-qr${pairingQr ? " has-code" : ""}`} aria-live="polite">
            {pairingQr ? (
              <img src={pairingQr} alt="Anchor Mobile encrypted relay pairing code" draggable={false} />
            ) : (
              <span>
                {enabled && state === "connecting"
                  ? "Connecting to relay…"
                  : enabled
                    ? "Waiting for the relay…"
                    : "Turn on Mobile access to show a pairing code"}
              </span>
            )}
          </div>
          <p>Pairing codes expire quickly. Source code and terminal data are encrypted before they enter the Relay.</p>
        </section>
      </div>
    </section>
  );
}
