export interface RelayConnection {
  mode: "relay";
  relayUrl: string;
  roomId: string;
  hostPeerId: string;
  peerId: string;
  ticket: string;
  secret: string;
  expiresAt?: string;
  paired?: boolean;
}

export type Connection = RelayConnection;

export interface RequestOptions extends RequestInit {
  timeoutMs?: number;
}

export interface RemoteTransport {
  request<T>(path: string, options?: RequestOptions): Promise<T>;
}

export class RemoteApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "RemoteApiError";
  }
}
