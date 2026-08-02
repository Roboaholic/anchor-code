// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  bootstrap: {
    version: "test",
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
    serverInstanceId: "server-test",
    host: { kind: "local", profileId: "local-default" },
    workspace: { root: "/workspace", name: "workspace" },
    repos: [{ root: "/workspace", name: "workspace" }],
    agents: [{ id: "codex", name: "Codex", command: "codex", enabled: true }],
    defaultAgentId: "codex",
    terminals: [] as Array<Record<string, unknown>>,
    terminalCursor: 0,
  },
  createSession: vi.fn(),
  snapshot: vi.fn(),
  compare: vi.fn(),
  fileDiff: vi.fn(),
  addComment: vi.fn(),
  setCommentStatus: vi.fn(),
}));

vi.mock("./MobileTerminal", () => ({
  MobileTerminal: ({ data }: { data: string }) => <div data-testid="mobile-terminal">{data}</div>,
}));

vi.mock("./MermaidBlock", () => ({
  MermaidBlock: ({ chart }: { chart: string }) => <div data-testid="mermaid-diagram">{chart}</div>,
}));

vi.mock("./repositories", () => ({
  AnchorRepositories: class {
    supports() { return true; }
    system = {
      negotiate: vi.fn().mockResolvedValue({ protocolVersion: "1.0", capabilities: fake.bootstrap.capabilities }),
      bootstrap: vi.fn().mockImplementation(async () => ({ ...fake.bootstrap, terminals: [...fake.bootstrap.terminals] })),
    };
    workspace = {
      list: vi.fn().mockResolvedValue({ active: { path: "/workspace", hostProfileId: "local-default" }, recent: [] }),
      listFiles: vi.fn().mockResolvedValue({ path: "/workspace", entries: [{ name: "README.md", type: "file" }] }),
      readFile: vi.fn().mockResolvedValue({ path: "/workspace/README.md", text: "# Baseline document\n\n```mermaid\ngraph TD\nA --> B\n```" }),
      search: vi.fn().mockResolvedValue({ hits: [] }),
      select: vi.fn(),
    };
    review = {
      status: vi.fn().mockResolvedValue({ branch: "main", modified: 0, added: 0, deleted: 0, entries: [] }),
      log: vi.fn().mockResolvedValue([{
        hash: "1111111111111111111111111111111111111111",
        shortHash: "1111111",
        subject: "Baseline commit",
        author: "Anchor CI",
        dateIso: "2026-01-01T00:00:00.000Z",
      }]),
      compare: fake.compare,
      fileDiff: fake.fileDiff,
    };
    comments = {
      list: vi.fn().mockResolvedValue({ sessions: [] }),
      add: fake.addComment,
      setStatus: fake.setCommentStatus,
    };
    agent = { createSession: fake.createSession };
    terminal = {
      snapshot: fake.snapshot,
      input: vi.fn().mockResolvedValue({ ok: true }),
      resize: vi.fn().mockResolvedValue({ ok: true }),
      remove: vi.fn().mockResolvedValue({ ok: true }),
      pollEvents: vi.fn().mockImplementation(() => new Promise(() => undefined)),
    };
  },
}));

import App from "./App";

const connection = {
  mode: "relay",
  relayUrl: "https://anchor-code-relay.anchor-code-mobile.workers.dev",
  roomId: "room",
  hostPeerId: "host",
  peerId: "mobile",
  ticket: "ticket",
  secret: "secret",
  paired: true,
};

describe("mobile Agent baseline", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(window, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    localStorage.setItem("anchor.mobile.connection.v1", JSON.stringify(connection));
    fake.bootstrap.terminals = [];
    fake.createSession.mockReset();
    fake.snapshot.mockReset();
    fake.snapshot.mockResolvedValue({ id: "agent-new", data: "Agent ready", seq: 1 });
    fake.compare.mockReset();
    fake.compare.mockResolvedValue({ files: [{ path: "src/example.ts", status: "M" }] });
    fake.fileDiff.mockReset();
    fake.fileDiff.mockResolvedValue({
      path: "src/example.ts",
      status: "M",
      oldText: "export const answer = 42;\n",
      newText: "export const answer = 43;\n",
    });
    fake.addComment.mockReset();
    fake.addComment.mockResolvedValue({
      comments: [{ id: "comment-new", status: "discussing" }],
    });
    fake.setCommentStatus.mockReset();
    fake.setCommentStatus.mockResolvedValue({ comments: [] });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("shows a newly created Agent session immediately", async () => {
    fake.createSession.mockResolvedValue({
      id: "agent-new",
      title: "Fix the regression",
      cwd: "/workspace",
      status: "running",
      kind: "agent",
      agentId: "codex",
    });

    render(<App />);
    await screen.findByText("Review 变更");
    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    fireEvent.click(await screen.findByRole("button", { name: "启动 Agent 会话" }));

    expect(await screen.findByText("Fix the regression")).toBeVisible();
    expect(screen.getByTestId("mobile-terminal")).toBeVisible();
    await waitFor(() => expect(screen.getByTestId("mobile-terminal")).toHaveTextContent("Agent ready"));
    expect(document.querySelector(".app-shell")).toHaveClass("app-shell--agent-terminal");
  });

  it("retries an initially empty Agent snapshot until PC output is available", async () => {
    fake.createSession.mockResolvedValue({
      id: "agent-delayed",
      title: "Delayed Agent",
      cwd: "/workspace",
      status: "running",
      kind: "agent",
      agentId: "codex",
    });
    fake.snapshot
      .mockResolvedValueOnce({ id: "agent-delayed", data: "", seq: 0 })
      .mockResolvedValue({ id: "agent-delayed", data: "Delayed Agent output", seq: 1 });

    render(<App />);
    await screen.findByText("Review 变更");
    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    fireEvent.click(await screen.findByRole("button", { name: "启动 Agent 会话" }));

    expect(await screen.findByText("正在同步 PC 端 Agent 输出")).toBeVisible();
    await waitFor(() => expect(fake.snapshot).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    await waitFor(() => expect(screen.getByTestId("mobile-terminal")).toHaveTextContent("Delayed Agent output"));
  });

  it("keeps snapshot recovery active after startup when terminal events are missing", async () => {
    fake.createSession.mockResolvedValue({
      id: "agent-late-response",
      title: "Late response Agent",
      cwd: "/workspace",
      status: "running",
      kind: "agent",
      agentId: "codex",
    });
    fake.snapshot
      .mockResolvedValueOnce({ id: "agent-late-response", data: "Agent starting", seq: 1 })
      .mockResolvedValue({ id: "agent-late-response", data: "Agent starting\nModel response arrived", seq: 2 });

    render(<App />);
    await screen.findByText("Review 变更");
    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    fireEvent.click(await screen.findByRole("button", { name: "启动 Agent 会话" }));

    await waitFor(() => expect(screen.getByTestId("mobile-terminal")).toHaveTextContent("Agent starting"));
    await waitFor(() => expect(screen.getByTestId("mobile-terminal")).toHaveTextContent("Model response arrived"), { timeout: 4_000 });
    expect(fake.snapshot.mock.calls.length).toBeGreaterThanOrEqual(2);
  }, 6_000);

  it("keeps existing sessions in the list instead of forcing hidden fullscreen", async () => {
    fake.bootstrap.terminals = [{
      id: "agent-existing",
      title: "Existing Agent",
      cwd: "/workspace",
      status: "running",
      kind: "agent",
      agentId: "codex",
    }];

    render(<App />);
    await screen.findByText("Review 变更");
    expect(document.querySelector(".app-shell")).not.toHaveClass("app-shell--agent-terminal");
    expect(screen.getByRole("button", { name: "Agent" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Review" })).toBeVisible();
    expect(screen.getByRole("button", { name: "文件" })).toBeVisible();
    expect(screen.getByRole("button", { name: "评论" })).toBeVisible();
  });

  it("saves a selected Review line through the comment API", async () => {
    const { container } = render(<App />);
    await screen.findByText("Review 变更");
    fireEvent.click(await screen.findByRole("button", { name: "比较当前工作区" }));
    fireEvent.click(await screen.findByRole("button", { name: /src\/example\.ts/ }));

    const changedLine = await waitFor(() => {
      const line = container.querySelector<HTMLButtonElement>(".inline-diff__row.is-added:not([disabled])");
      expect(line).toBeTruthy();
      return line!;
    });
    fireEvent.click(changedLine);
    fireEvent.click(await screen.findByRole("button", { name: "添加评论" }));
    fireEvent.change(screen.getByPlaceholderText("说明问题、建议或需要 Agent 修改的内容…"), {
      target: { value: "Please keep the baseline behavior" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存评论" }));

    await waitFor(() => expect(fake.addComment).toHaveBeenCalledWith(expect.objectContaining({
      filePath: "/workspace/src/example.ts",
      selectedText: "export const answer = 43;",
      body: "Please keep the baseline behavior",
    })));
    await waitFor(() => expect(fake.setCommentStatus).toHaveBeenCalledWith("/workspace", "comment-new", "need_modify"));
    expect(await screen.findByText("审阅意见已记录")).toBeVisible();
  });

  it("renders Markdown and Mermaid from the Files tab", async () => {
    render(<App />);
    await screen.findByText("Review 变更");
    fireEvent.click(screen.getByRole("button", { name: "文件" }));
    fireEvent.click(await screen.findByRole("button", { name: /README\.md/ }));

    expect(await screen.findByRole("heading", { name: "Baseline document" })).toBeVisible();
    expect(screen.getByTestId("mermaid-diagram")).toHaveTextContent("graph TD");
  });
});
