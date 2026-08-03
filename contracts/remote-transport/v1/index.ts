export const REMOTE_TRANSPORT_VERSION = 1 as const;
export const REMOTE_TRANSPORT_MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const REMOTE_TRANSPORT_REQUEST_TIMEOUT_MS = 30_000;

export type RemoteTransportMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface RemoteTransportRequest {
  v: typeof REMOTE_TRANSPORT_VERSION;
  type: "request";
  requestId: string;
  method: RemoteTransportMethod;
  path: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
}

export interface RemoteTransportResponse {
  v: typeof REMOTE_TRANSPORT_VERSION;
  type: "response";
  requestId: string;
  status: number;
  body: unknown;
}

export type RemoteTransportMessage =
  | RemoteTransportRequest
  | RemoteTransportResponse;

export type RelayRole = "host" | "guest";

export interface RelayHelloFrame {
  v: typeof REMOTE_TRANSPORT_VERSION;
  type: "hello";
  role: RelayRole;
  roomId: string;
  peerId: string;
  ticket: string;
}

export interface RelayPeerFrame {
  v: typeof REMOTE_TRANSPORT_VERSION;
  type: "peer";
  state: "online" | "offline";
  peerId: string;
  role: RelayRole;
}

export interface RelaySealedFrame {
  v: typeof REMOTE_TRANSPORT_VERSION;
  type: "sealed";
  from: string;
  to?: string;
  sessionId: string;
  sequence: number;
  iv: string;
  ciphertext: string;
}

export interface RelayErrorFrame {
  v: typeof REMOTE_TRANSPORT_VERSION;
  type: "relay-error";
  code: string;
  message: string;
  retryable: boolean;
}

export interface RelayCredentialFrame {
  v: typeof REMOTE_TRANSPORT_VERSION;
  type: "credential";
  peerId: string;
  ticket: string;
}

export interface RelayDevicesFrame {
  v: typeof REMOTE_TRANSPORT_VERSION;
  type: "devices";
  peerIds: string[];
}

export interface RelayPairingRequestFrame {
  v: typeof REMOTE_TRANSPORT_VERSION;
  type: "pairing-request";
  peerId: string;
}

export interface RelayControlFrame {
  v: typeof REMOTE_TRANSPORT_VERSION;
  type: "control";
  action: "approve" | "revoke";
  peerId: string;
}

export type RelayFrame =
  | RelayHelloFrame
  | RelayPeerFrame
  | RelaySealedFrame
  | RelayErrorFrame
  | RelayCredentialFrame
  | RelayDevicesFrame
  | RelayPairingRequestFrame
  | RelayControlFrame;

export interface RelayPairingPayload {
  v: typeof REMOTE_TRANSPORT_VERSION;
  type: "anchor-code-relay";
  relayUrl: string;
  roomId: string;
  hostPeerId: string;
  ticket: string;
  secret: string;
  expiresAt: string;
}

export function isRemoteTransportRequest(value: unknown): value is RemoteTransportRequest {
  if (!value || typeof value !== "object") return false;
  const frame = value as Partial<RemoteTransportRequest>;
  return frame.v === REMOTE_TRANSPORT_VERSION &&
    frame.type === "request" &&
    typeof frame.requestId === "string" &&
    typeof frame.method === "string" &&
    typeof frame.path === "string";
}

export function isRemoteTransportResponse(value: unknown): value is RemoteTransportResponse {
  if (!value || typeof value !== "object") return false;
  const frame = value as Partial<RemoteTransportResponse>;
  return frame.v === REMOTE_TRANSPORT_VERSION &&
    frame.type === "response" &&
    typeof frame.requestId === "string" &&
    typeof frame.status === "number";
}

export function isRelayFrame(value: unknown): value is RelayFrame {
  if (!value || typeof value !== "object") return false;
  const frame = value as Partial<RelayFrame>;
  return frame.v === REMOTE_TRANSPORT_VERSION &&
    typeof frame.type === "string" &&
    ["hello", "peer", "sealed", "relay-error", "credential", "devices", "pairing-request", "control"].includes(frame.type);
}
