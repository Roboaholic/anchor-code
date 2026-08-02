import type { AppOverrides } from "./App";
import type { Bootstrap, Connection, TerminalInfo } from "./api";
import type { AnchorRepositories, CommentRecord, Session } from "./repositories";

const connection: Connection = {
  mode: "relay",
  relayUrl: "https://anchor-code-relay.anchor-code-mobile.workers.dev",
  roomId: "baseline-room",
  hostPeerId: "baseline-host",
  peerId: "baseline-mobile",
  ticket: "baseline-ticket",
  secret: "baseline-secret",
  paired: true,
};

const statusEntries = Array.from({ length: 18 }, (_, index) => ({
  code: index % 3 === 0 ? "A " : "M ",
  status: index % 3 === 0 ? "added" : "modified",
  path: `src/baseline-${String(index + 1).padStart(2, "0")}.ts`,
}));

const bootstrap: Bootstrap = {
  version: "baseline",
  protocolVersion: "1.0",
  capabilities: [
    "workspace.select",
    "review.inline-diff",
    "review.side-by-side-diff",
    "comments.lifecycle",
    "agent.session-sync",
    "terminal.snapshot-seq",
    "terminal.long-poll-events",
  ],
  serverInstanceId: "baseline-server",
  host: { kind: "local", profileId: "local-default" },
  workspace: { root: "/baseline", name: "Baseline Workspace" },
  repos: [{ root: "/baseline", name: "baseline" }],
  agents: [{ id: "codex", name: "Codex", command: "codex", detected: true, enabled: true }],
  defaultAgentId: "codex",
  terminals: [],
  terminalCursor: 0,
};

function makeComment(body: string): CommentRecord {
  return {
    id: "comment-baseline",
    status: "discussing",
    target: {
      file_path: "/baseline/src/example.ts",
      kind: "source",
      start_line: 2,
      end_line: 2,
      start_column: 1,
      end_column: 24,
      selected_text: "export const answer = 43;",
      before_context: "export const name = 'Anchor';",
      after_context: "console.log(answer);",
    },
    author: "mobile-user",
    messages: [{ id: "message-baseline", author: "mobile-user", body, created_at: new Date(0).toISOString() }],
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  };
}

export function createBaselineFixture(): AppOverrides {
  const terminals = new Map<string, TerminalInfo>();
  const terminalOutput = new Map<string, string>();
  let comments: CommentRecord[] = [];

  const commentSession = (): Session => ({
    version: 1,
    id: "session-baseline",
    title: "Baseline Review",
    status: "active",
    author: "mobile-user",
    created_at: new Date(0).toISOString(),
    ended_at: null,
    notes: "",
    comments,
  });

  const repositories = {
    supports: () => true,
    system: {
      negotiate: async () => null,
      bootstrap: async () => ({ ...bootstrap, terminals: [...terminals.values()] }),
      health: async () => ({ ok: true }),
    },
    workspace: {
      list: async () => ({ active: { path: "/baseline", hostProfileId: "local-default" }, recent: [] }),
      select: async () => ({ ok: true as const }),
      listFiles: async (path: string) => ({
        path,
        entries: path === "/baseline"
          ? [
              { name: "README.md", type: "file" as const },
              { name: "src", type: "dir" as const },
            ]
          : [
              { name: "example.ts", type: "file" as const },
              { name: "long-file.ts", type: "file" as const },
            ],
      }),
      readFile: async (path: string) => ({
        path,
        text: path.endsWith(".md")
          ? "# Anchor Mobile Baseline\n\n- Markdown works\n- Navigation stays visible\n\n```mermaid\ngraph TD\n  A[APK] --> B[Baseline]\n```\n"
          : Array.from({ length: 80 }, (_, index) => `export const line${index + 1} = ${index + 1};`).join("\n"),
      }),
      search: async () => ({ hits: [] }),
    },
    review: {
      status: async () => ({
        branch: "main",
        modified: 12,
        added: 4,
        deleted: 2,
        untracked: 0,
        entries: statusEntries,
      }),
      log: async () => [{
        hash: "1111111111111111111111111111111111111111",
        shortHash: "1111111",
        subject: "Baseline commit",
        author: "Anchor CI",
        dateIso: "2026-01-01T00:00:00.000Z",
      }],
      compare: async () => ({ files: [{ path: "src/example.ts", status: "M" }] }),
      fileDiff: async () => ({
        path: "src/example.ts",
        status: "M",
        oldText: "export const name = 'Anchor';\nexport const answer = 42;\nconsole.log(answer);\n",
        newText: "export const name = 'Anchor';\nexport const answer = 43;\nconsole.log(answer);\n",
      }),
    },
    comments: {
      list: async () => ({ sessions: comments.length ? [commentSession()] : [] }),
      add: async (input: { body: string }) => {
        comments = [...comments, makeComment(input.body)];
        return commentSession();
      },
      setStatus: async (_repoRoot: string, commentId: string, status: CommentRecord["status"]) => {
        comments = comments.map((comment) => comment.id === commentId ? { ...comment, status } : comment);
        return commentSession();
      },
      reply: async () => commentSession(),
    },
    agent: {
      createSession: async () => {
        const terminal: TerminalInfo = {
          id: "agent-baseline",
          title: "Baseline Agent Session",
          cwd: "/baseline",
          status: "running",
          kind: "agent",
          agentId: "codex",
        };
        terminals.set(terminal.id, terminal);
        terminalOutput.set(terminal.id, "\u001b[32mAnchor Agent ready\u001b[0m\r\n› baseline task");
        return terminal;
      },
    },
    terminal: {
      snapshot: async (id: string) => ({ id, data: terminalOutput.get(id) ?? "", seq: 1 }),
      input: async () => ({ ok: true as const }),
      resize: async () => ({ ok: true as const }),
      remove: async (id: string) => {
        terminals.delete(id);
        terminalOutput.delete(id);
        return { ok: true as const };
      },
      pollEvents: async () => new Promise(() => undefined),
    },
  } as unknown as AnchorRepositories;

  return {
    initialConnection: connection,
    initialBootstrap: bootstrap,
    repositories,
  };
}
