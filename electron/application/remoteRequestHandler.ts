import { randomUUID } from "node:crypto";
import { HostError } from "../host/types.js";
import type { AnchorApplication } from "./anchorApplication.js";
import {
  toRemoteAgentLaunchOptions,
  toRemoteAgentProfile,
  toRemoteApplicationEvent,
  toRemoteBootstrap,
  toRemoteCommentExport,
  toRemoteCommentSession,
  toRemoteCommit,
  toRemoteDiffFile,
  toRemoteDirEntries,
  toRemoteEndCommentSession,
  toRemoteFileDiff,
  toRemoteFileIndex,
  toRemoteRepoStatus,
  toRemoteRepos,
  toRemoteSearchHits,
  toRemoteTerminalInfo,
  toRemoteWorkspaceCatalog,
} from "../adapters/remote/dtoMappers.js";
import {
  REMOTE_CAPABILITIES,
  REMOTE_MIN_PROTOCOL_VERSION,
  REMOTE_PROTOCOL_VERSION,
  type RemoteBootstrap,
  type RemoteEventEnvelope,
  type RemoteMeta,
} from "../../contracts/remote-api/v1/index.js";
import type {
  RemoteTransportMethod,
  RemoteTransportRequest,
} from "../../contracts/remote-transport/v1/index.js";

const MAX_EVENT_COUNT = 1_000;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_EVENT_DATA_CHARS = 64 * 1024;

type AddCommentInput = Parameters<AnchorApplication["comments"]["add"]>[0];
type CommentStatus = Parameters<AnchorApplication["comments"]["setStatus"]>[2];

export interface RemoteRequest {
  method: RemoteTransportMethod;
  path: string;
  query?: URLSearchParams | Record<string, string>;
  body?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface RemoteResponse {
  status: number;
  body: unknown;
}

export function remoteErrorPayload(
  error: unknown,
  requestId?: string,
): { error: { code: string; message: string; requestId?: string } } {
  const payload = error instanceof HostError
    ? { code: error.code, message: error.message }
    : { code: "failed", message: error instanceof Error ? error.message : String(error) };
  return { error: { ...payload, ...(requestId ? { requestId } : {}) } };
}

export function remoteStatusForError(error: unknown): number {
  if (error instanceof HostError) {
    if (error.code === "not_found") return 404;
    if (error.code === "permission") return 403;
    if (error.code === "timeout") return 504;
  }
  return 400;
}

function stringValue(value: unknown, name: string, optional = false): string {
  if (optional && (value === undefined || value === null)) return "";
  if (typeof value !== "string" || (!optional && !value.trim())) {
    throw new HostError("failed", `${name} is required`);
  }
  return value;
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function queryValue(query: RemoteRequest["query"], name: string): string | null {
  if (!query) return null;
  if (query instanceof URLSearchParams) return query.get(name);
  return query[name] ?? null;
}

function bodyValue(request: RemoteRequest): Record<string, unknown> {
  return request.body ?? {};
}

export function fromTransportRequest(frame: RemoteTransportRequest): RemoteRequest {
  return {
    method: frame.method,
    path: frame.path,
    query: frame.query,
    body: frame.body,
  };
}

export class RemoteRequestHandler {
  private seq = 0;
  private events: RemoteEventEnvelope[] = [];
  private eventBytes = 0;
  private waiters = new Set<() => void>();
  private serverInstanceId = randomUUID();
  private unsubscribeApplication: (() => void) | null = null;

  constructor(
    private readonly opts: {
      appVersion: string;
      application: AnchorApplication;
    },
  ) {
  }

  /** Enable event observation only while a remote client can consume it. */
  setActive(active: boolean): void {
    if (active && !this.unsubscribeApplication) {
      this.unsubscribeApplication = this.opts.application.subscribe((event) => {
        const mapped = toRemoteApplicationEvent(event);
        const safeEvent = mapped.type === "data" && mapped.data.length > MAX_EVENT_DATA_CHARS
          ? { ...mapped, data: mapped.data.slice(-MAX_EVENT_DATA_CHARS) }
          : mapped;
        const envelope: RemoteEventEnvelope = {
          seq: ++this.seq,
          at: new Date().toISOString(),
          serverInstanceId: this.serverInstanceId,
          event: safeEvent,
        };
        this.events.push(envelope);
        this.eventBytes += Buffer.byteLength(JSON.stringify(envelope.event), "utf8");
        while (
          this.events.length > MAX_EVENT_COUNT ||
          this.eventBytes > MAX_EVENT_BYTES
        ) {
          const removed = this.events.shift();
          if (!removed) break;
          this.eventBytes -= Buffer.byteLength(JSON.stringify(removed.event), "utf8");
        }
        for (const wake of this.waiters) wake();
        this.waiters.clear();
      });
      return;
    }
    if (!active) {
      this.unsubscribeApplication?.();
      this.unsubscribeApplication = null;
      this.clearEvents();
      this.wakeWaiters();
    }
  }

  private clearEvents(): void {
    this.events = [];
    this.eventBytes = 0;
  }

  private wakeWaiters(): void {
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  /* reset is safe both while active and while inactive. */
  reset(): void {
    this.seq = 0;
    this.clearEvents();
    this.serverInstanceId = randomUUID();
    this.wakeWaiters();
  }

  dispose(): void {
    this.setActive(false);
  }

  meta(): RemoteMeta {
    return {
      serverVersion: this.opts.appVersion,
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      minProtocolVersion: REMOTE_MIN_PROTOCOL_VERSION,
      capabilities: [...REMOTE_CAPABILITIES],
      serverInstanceId: this.serverInstanceId,
    };
  }

  private async bootstrap(): Promise<RemoteBootstrap> {
    const workspace = this.opts.application.workspace.current();
    const [repos, agentCatalog, terminals] = await Promise.all([
      this.opts.application.review.repos(),
      this.opts.application.agent.listProfiles(),
      Promise.resolve(this.opts.application.terminal.list()),
    ]);
    return toRemoteBootstrap({
      version: this.opts.appVersion,
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      capabilities: [...REMOTE_CAPABILITIES],
      serverInstanceId: this.serverInstanceId,
      host: { kind: workspace.hostKind, profileId: workspace.hostProfileId },
      workspace: { root: this.opts.application.workspace.root(), name: workspace.name },
      repos,
      agents: agentCatalog.profiles,
      defaultAgentId: agentCatalog.defaultAgentId,
      terminals,
      terminalCursor: this.seq,
    });
  }

  async handle(request: RemoteRequest): Promise<RemoteResponse> {
    const { method, path } = request;
    const query = (name: string) => queryValue(request.query, name);
    const ok = (body: unknown): RemoteResponse => ({ status: 200, body });

    if (method === "GET" && path === "/api/v1/meta") return ok(this.meta());

    if (method === "GET" && path === "/api/v1/health") {
      const workspace = this.opts.application.workspace.active();
      return ok({
        ok: true,
        version: this.opts.appVersion,
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        capabilities: [...REMOTE_CAPABILITIES],
        serverInstanceId: this.serverInstanceId,
        hostKind: workspace?.hostKind ?? this.opts.application.workspace.hostInfo().kind,
        workspaceRoot: workspace?.path ?? null,
        terminalCursor: this.seq,
      });
    }

    if (method === "GET" && path === "/api/v1/bootstrap") return ok(await this.bootstrap());

    if (method === "GET" && path === "/api/v1/workspaces") {
      return ok(toRemoteWorkspaceCatalog(await this.opts.application.workspace.listApproved()));
    }

    if (method === "POST" && path === "/api/v1/workspaces/select") {
      const body = bodyValue(request);
      const selected = await this.opts.application.workspace.open(
        {
          path: stringValue(body.path, "path"),
          hostProfileId: stringValue(body.hostProfileId, "hostProfileId"),
        },
        { requireApproved: true, source: "remote" },
      );
      return ok({ ok: true, active: { path: selected.root, hostProfileId: selected.hostProfileId } });
    }

    if (method === "GET" && path === "/api/v1/files") {
      const result = await this.opts.application.review.listFiles(query("path"));
      return ok({ path: result.path, entries: toRemoteDirEntries(result.entries) });
    }

    if (method === "GET" && path === "/api/v1/file") {
      return ok(await this.opts.application.review.readFile(stringValue(query("path"), "path")));
    }

    if (method === "GET" && path === "/api/v1/file-index") {
      return ok(toRemoteFileIndex(await this.opts.application.review.fileIndex(numberValue(query("maxFiles"), 5000))));
    }

    if (method === "GET" && path === "/api/v1/search") {
      const result = await this.opts.application.review.search(query("q") ?? "", {
        maxResults: numberValue(query("maxResults"), 100),
        caseSensitive: query("caseSensitive") === "true",
        useRegex: query("regex") === "true",
      });
      return ok({ ...result, hits: toRemoteSearchHits(result.hits) });
    }

    if (method === "GET" && path === "/api/v1/repos") {
      return ok(toRemoteRepos(await this.opts.application.review.repos()));
    }

    if (method === "GET" && path === "/api/v1/history/log") {
      const commits = await this.opts.application.review.log(stringValue(query("repoRoot"), "repoRoot"));
      return ok(commits.map(toRemoteCommit));
    }

    if (method === "GET" && path === "/api/v1/history/status") {
      return ok(toRemoteRepoStatus(await this.opts.application.review.status(stringValue(query("repoRoot"), "repoRoot"))));
    }

    if (method === "POST" && path === "/api/v1/history/compare") {
      const body = bodyValue(request);
      const result = await this.opts.application.review.compare(
        stringValue(body.repoRoot, "repoRoot"),
        stringValue(body.base, "base"),
        stringValue(body.head, "head"),
      );
      return ok({ ...result, files: result.files.map(toRemoteDiffFile) });
    }

    if (method === "POST" && path === "/api/v1/history/file-diff") {
      const body = bodyValue(request);
      return ok(toRemoteFileDiff(await this.opts.application.review.fileDiff({
        repoRoot: stringValue(body.repoRoot, "repoRoot"),
        base: stringValue(body.base, "base"),
        head: stringValue(body.head, "head") as string | "worktree",
        path: stringValue(body.path, "path"),
        status: stringValue(body.status, "status"),
      })));
    }

    if (method === "GET" && path === "/api/v1/comments") {
      const result = await this.opts.application.comments.list(stringValue(query("repoRoot"), "repoRoot"));
      return ok({ ...result, sessions: result.sessions.map(toRemoteCommentSession) });
    }

    if (method === "POST" && path === "/api/v1/comments/session") {
      const body = bodyValue(request);
      return ok(toRemoteCommentSession(await this.opts.application.comments.ensureSession(
        stringValue(body.repoRoot, "repoRoot"),
        stringValue(body.title, "title", true) || undefined,
        "mobile-user",
      )));
    }

    if (method === "POST" && path === "/api/v1/comments") {
      const body = bodyValue(request);
      return ok(toRemoteCommentSession(await this.opts.application.comments.add({
        ...(body as unknown as AddCommentInput),
        repoRoot: stringValue(body.repoRoot, "repoRoot"),
        filePath: stringValue(body.filePath, "filePath"),
        body: stringValue(body.body, "body"),
      }, { author: "mobile-user" })));
    }

    const commentMatch = path.match(/^\/api\/v1\/comments\/([^/]+)(?:\/(status|reply|edit))?$/);
    if (commentMatch && (method === "PATCH" || method === "DELETE" || method === "POST")) {
      const commentId = decodeURIComponent(commentMatch[1]!);
      const action = commentMatch[2];
      const body = bodyValue(request);
      const repoRoot = stringValue(body.repoRoot ?? query("repoRoot"), "repoRoot");
      if (method === "DELETE") {
        return ok(toRemoteCommentSession(await this.opts.application.comments.remove(repoRoot, commentId)));
      }
      if (action === "status") {
        return ok(toRemoteCommentSession(await this.opts.application.comments.setStatus(repoRoot, commentId, stringValue(body.status, "status") as CommentStatus)));
      }
      if (action === "reply") {
        return ok(toRemoteCommentSession(await this.opts.application.comments.reply(repoRoot, commentId, stringValue(body.body, "body"), "mobile-user")));
      }
      if (action === "edit") {
        return ok(toRemoteCommentSession(await this.opts.application.comments.edit(repoRoot, commentId, stringValue(body.body, "body"), stringValue(body.messageId, "messageId", true) || undefined)));
      }
      throw new HostError("not_found", "Unknown comment action");
    }

    if (method === "POST" && path === "/api/v1/comments/end-session") {
      const body = bodyValue(request);
      return ok(toRemoteEndCommentSession(await this.opts.application.comments.end(stringValue(body.repoRoot, "repoRoot"), {
        export: body.export !== false,
        sessionId: stringValue(body.sessionId, "sessionId", true) || undefined,
      })));
    }

    if (method === "POST" && path === "/api/v1/comments/new-session") {
      const body = bodyValue(request);
      return ok(toRemoteCommentSession(await this.opts.application.comments.create(stringValue(body.repoRoot, "repoRoot"), stringValue(body.title, "title", true) || undefined, "mobile-user")));
    }

    if (method === "POST" && path === "/api/v1/comments/restore-session") {
      const body = bodyValue(request);
      return ok(toRemoteCommentSession(await this.opts.application.comments.restore(stringValue(body.repoRoot, "repoRoot"), stringValue(body.sessionId, "sessionId"))));
    }

    if (method === "POST" && path === "/api/v1/comments/export") {
      const body = bodyValue(request);
      return ok(toRemoteCommentExport(await this.opts.application.comments.export(stringValue(body.repoRoot, "repoRoot"), stringValue(body.sessionId, "sessionId", true) || undefined)));
    }

    if (method === "GET" && path === "/api/v1/agents") {
      const result = await this.opts.application.agent.listProfiles();
      return ok({ profiles: result.profiles.map(toRemoteAgentProfile), defaultAgentId: result.defaultAgentId });
    }

    if (method === "GET" && path === "/api/v1/agents/launch-options") {
      return ok(toRemoteAgentLaunchOptions(await this.opts.application.agent.launchOptions(stringValue(query("profileId"), "profileId"))));
    }

    if (method === "POST" && path === "/api/v1/agents/sessions") {
      const body = bodyValue(request);
      return ok(toRemoteTerminalInfo(await this.opts.application.agent.createSession({
        profileId: stringValue(body.profileId, "profileId"),
        model: stringValue(body.model, "model", true) || undefined,
        effort: stringValue(body.effort, "effort", true) || undefined,
        prompt: stringValue(body.prompt, "prompt", true) || undefined,
        cols: numberValue(body.cols, 56),
        rows: numberValue(body.rows, 28),
      })));
    }

    if (method === "GET" && path === "/api/v1/terminals") {
      return ok(this.opts.application.terminal.list().map(toRemoteTerminalInfo));
    }

    if (method === "POST" && path === "/api/v1/terminals") {
      const body = bodyValue(request);
      return ok(toRemoteTerminalInfo(await this.opts.application.terminal.create({
        cols: numberValue(body.cols, 56),
        rows: numberValue(body.rows, 28),
        kind: "shell",
      })));
    }

    if (method === "GET" && path === "/api/v1/terminal-events") {
      const after = numberValue(query("after"), 0);
      const earliest = this.events[0]?.seq;
      const bootstrapRequired = this.events.length === 0
        ? after < this.seq
        : typeof earliest === "number" && after < earliest - 1;
      if (!bootstrapRequired && !this.events.some((item) => item.seq > after)) {
        await this.waitForEvent(numberValue(query("waitMs"), 15_000), request.signal);
      }
      return ok({
        cursor: this.seq,
        serverInstanceId: this.serverInstanceId,
        bootstrapRequired,
        events: this.events.filter((item) => item.seq > after),
      });
    }

    const terminalMatch = path.match(/^\/api\/v1\/terminals\/([^/]+)(?:\/(input|resize))?$/);
    if (terminalMatch) {
      const id = decodeURIComponent(terminalMatch[1]!);
      const action = terminalMatch[2];
      if (method === "GET" && !action) {
        const snapshot = this.opts.application.terminal.snapshot(id);
        const afterSeq = numberValue(query("afterSeq"), -1);
        if (afterSeq >= snapshot.seq) {
          return ok({ ...snapshot, data: "", unchanged: true });
        }
        return ok(snapshot);
      }
      if (method === "DELETE") {
        this.opts.application.terminal.remove(id);
        return ok({ ok: true });
      }
      if (method === "POST" && action === "input") {
        this.opts.application.terminal.write(id, stringValue(bodyValue(request).data, "data", true));
        return ok({ ok: true });
      }
      if (method === "POST" && action === "resize") {
        const body = bodyValue(request);
        this.opts.application.terminal.resize(id, numberValue(body.cols, 56), numberValue(body.rows, 28));
        return ok({ ok: true });
      }
    }

    throw new HostError("not_found", `Remote route not found: ${method} ${path}`);
  }

  private async waitForEvent(waitMs: number, signal?: AbortSignal): Promise<void> {
    const bounded = Math.max(0, Math.min(waitMs, 25_000));
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.waiters.delete(finish);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, bounded);
      this.waiters.add(finish);
      signal?.addEventListener("abort", finish, { once: true });
      if (signal?.aborted) finish();
    });
  }
}
