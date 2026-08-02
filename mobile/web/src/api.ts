import { RelayTransport } from "./transport/relayTransport";
import {
  type Connection,
  type RemoteTransport,
  type RequestOptions,
} from "./transport/types";

export type {
  Connection,
  RelayConnection,
  RequestOptions,
} from "./transport/types";
export { RemoteApiError } from "./transport/types";

export type {
  RemoteAgentProfile as AgentProfile,
  RemoteBootstrap as Bootstrap,
  RemoteTerminalEvent as TerminalEvent,
  RemoteTerminalInfo as TerminalInfo,
} from "@anchor-code/remote-contract/v1";

export class AnchorRemoteApi {
  private readonly transport: RemoteTransport;

  constructor(connection: Connection) {
    this.transport = new RelayTransport(connection);
  }

  request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.transport.request(path, options);
  }

  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request(path, options);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request(path, { method: "POST", body: JSON.stringify(body) });
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request(path, { method: "PATCH", body: JSON.stringify(body) });
  }

  delete<T>(path: string): Promise<T> {
    return this.request(path, { method: "DELETE" });
  }
}

export function joinPath(root: string, child: string): string {
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${child.replace(/^[\\/]+/, "")}`;
}

export function basename(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/$/, "").split("/").pop() || path;
}

export function dirname(path: string): string {
  const windows = path.includes("\\");
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const parent = normalized.slice(0, normalized.lastIndexOf("/")) || "/";
  return windows ? parent.replace(/\//g, "\\") : parent;
}
