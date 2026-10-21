// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnchorApi } from "@/shared/anchor-api";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import { FileTree } from "./FileTree";

vi.mock("@/features/shell/orchestrate", () => ({
  openFileFromTree: vi.fn(),
  openWorkspacePath: vi.fn(),
}));
vi.mock("@/features/shell/QuickOpen", () => ({
  applyFileIndexDelta: vi.fn(),
  invalidateFileIndexCache: vi.fn(),
  warmFileIndexCache: vi.fn(),
}));

type SearchArgs = Parameters<AnchorApi["workspace"]["searchContent"]>[0];
type SearchResult = Awaited<ReturnType<AnchorApi["workspace"]["searchContent"]>>;
type HitListener = Parameters<AnchorApi["workspace"]["onSearchHits"]>[0];
type MetaListener = Parameters<AnchorApi["workspace"]["onSearchMeta"]>[0];
type Request = {
  args: SearchArgs;
  resolve: (value: SearchResult) => void;
  reject: (error: Error) => void;
};

const hit = (path: string, line = 1) => ({ path, line, text: `needle in ${path}` });
let requests: Request[];
let hitListeners: Set<HitListener>;
let metaListeners: Set<MetaListener>;
let frames: Map<number, FrameRequestCallback>;
let cancelSearch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  localStorage.clear();
  requests = [];
  hitListeners = new Set();
  metaListeners = new Set();
  frames = new Map();
  let nextFrame = 1;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  cancelSearch = vi.fn(async () => ({ ok: true }));
  Object.assign(window, {
    anchor: {
      workspace: {
        watchStart: vi.fn(async () => ({ ok: true })),
        watchStop: vi.fn(async () => ({ ok: true })),
        readSearchIgnore: vi.fn(async () => ({ path: "/repo/.anchorignore", text: "", defaultExcludes: [] })),
        cancelSearch,
        searchContent: vi.fn((args: SearchArgs) => new Promise<SearchResult>((resolve, reject) => {
          requests.push({ args, resolve, reject });
        })),
        onSearchHits: (listener: HitListener) => {
          hitListeners.add(listener);
          return () => { hitListeners.delete(listener); };
        },
        onSearchMeta: (listener: MetaListener) => {
          metaListeners.add(listener);
          return () => { metaListeners.delete(listener); };
        },
      },
    },
  });
  useWorkspaceStore.setState({
    workspaceRoot: "/repo",
    workspaceName: "repo",
    hostKind: "local",
    status: "ready",
    error: null,
    rootEntries: [],
    selectedPath: null,
    recent: [],
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function search(query = "needle"): Promise<Request> {
  fireEvent.change(screen.getByRole("searchbox", { name: "Search in files" }), { target: { value: query } });
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  return requests[requests.length - 1]!;
}

function stream(request: Request, hits: SearchResult["hits"]) {
  act(() => {
    hitListeners.forEach((listener) => listener({ requestId: request.args.requestId!, hits }));
  });
}

function engine(request: Request, source: SearchResult["source"]) {
  act(() => {
    metaListeners.forEach((listener) => listener({ requestId: request.args.requestId!, source }));
  });
}

async function finish(request: Request, overrides: Partial<SearchResult> = {}) {
  await act(async () => {
    request.resolve({
      root: request.args.root!,
      query: request.args.query,
      requestId: request.args.requestId!,
      hits: [],
      truncated: false,
      source: "rg",
      status: "complete",
      ...overrides,
    });
  });
}

describe("FileTree search coverage", () => {
  it.each(["rg", "git-grep", "scan"] as const)("shows the %s engine even when it finds no matches", async (source) => {
    render(<FileTree />);
    const request = await search();
    expect(screen.getByRole("status").textContent).toBe("Searching…");
    engine(request, source);
    expect(screen.getByLabelText(`Search engine: ${source}`)).toBeTruthy();
    expect(screen.queryByText(/No matches/)).toBeNull();
    await finish(request, { source });
    expect(screen.getByText("No matches in searched files")).toBeTruthy();
    expect(screen.getByLabelText(`Search engine: ${source}`)).toBeTruthy();
  });

  it.each([0, 1])("shows partial coverage and actionable diagnostics with %i matches, without inventing a next page", async (count) => {
    render(<FileTree />);
    const request = await search();
    await finish(request, {
      hits: count ? [hit("found.ts")] : [],
      source: "scan",
      status: "partial",
      diagnostics: [{ code: "scan-limit", message: "Some files were skipped. Narrow the include filter and search again." }],
    });
    expect(screen.getByRole("status").textContent).toContain("Search incomplete");
    expect(screen.getByLabelText("Search engine: scan")).toBeTruthy();
    expect(
      screen.getByText("Some files were skipped. Narrow the include filter and search again."),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Search details/ }).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();
    if (!count) expect(screen.getByRole("status").textContent).toContain("No matches in searched files");
  });

  it("shows a failed empty search and its diagnostics, rather than a no-match result", async () => {
    render(<FileTree />);
    const request = await search();
    await finish(request, {
      status: "failed",
      source: "git-grep",
      diagnostics: [{ code: "permission-denied", message: "Cannot read the workspace. Check folder permissions." }],
    });
    expect(screen.getByText("Search failed")).toBeTruthy();
    expect(screen.getByLabelText("Search engine: git-grep")).toBeTruthy();
    expect(screen.getByText("Cannot read the workspace. Check folder permissions.")).toBeTruthy();
    expect(screen.queryByText(/No matches/)).toBeNull();
  });

  it("keeps streamed hits and the pending frame on rejection", async () => {
    render(<FileTree />);
    const request = await search();
    engine(request, "rg");
    stream(request, [hit("first.ts")]);
    stream(request, [hit("pending.ts")]);
    expect(screen.queryByText("pending.ts")).toBeNull();
    expect(frames.size).toBe(1);
    await act(async () => { request.reject(new Error("Connection lost. Reconnect the host and try again.")); });
    expect(screen.getByText("first.ts")).toBeTruthy();
    expect(screen.getByText("pending.ts")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Search failed · 2 results in 2 files kept");
    expect(screen.getByLabelText("Search engine: rg")).toBeTruthy();
    expect(screen.getByText("Connection lost. Reconnect the host and try again.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();
    expect(frames.size).toBe(0);
    expect(hitListeners.size).toBe(0);
  });

  it("flushes the pending frame on Stop and ignores a late response", async () => {
    render(<FileTree />);
    const request = await search();
    engine(request, "scan");
    stream(request, [hit("first.ts")]);
    stream(request, [hit("pending.ts")]);
    fireEvent.click(screen.getByRole("button", { name: "Stop search" }));
    expect(screen.getByText("pending.ts")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Search stopped · 2 results in 2 files kept");
    expect(cancelSearch).toHaveBeenCalledWith(request.args.requestId);
    expect(frames.size).toBe(0);
    expect(hitListeners.size).toBe(0);
    expect(metaListeners.size).toBe(0);
    await finish(request, { hits: [hit("late.ts"), hit("late2.ts"), hit("late3.ts")], truncated: true });
    expect(screen.queryByText("late.ts")).toBeNull();
    expect(screen.getByText("first.ts")).toBeTruthy();
    expect(screen.getByLabelText("Search engine: scan")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Search stopped");
    expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();
  });

  it("does not claim a complete no-match result when stopped before any hits", async () => {
    render(<FileTree />);
    await search();
    fireEvent.click(screen.getByRole("button", { name: "Stop search" }));
    expect(screen.getByText("Search stopped · No matches found so far")).toBeTruthy();
    expect(screen.queryByText("No matches in searched files")).toBeNull();
    expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();
  });

  it("honors legacy aborted results and keeps streamed hits", async () => {
    render(<FileTree />);
    const request = await search();
    stream(request, [hit("first.ts")]);
    stream(request, [hit("pending.ts")]);
    await finish(request, { status: undefined, aborted: true, truncated: true });
    expect(screen.getByText("pending.ts")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Search stopped");
    expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();
  });

  it("invalidates stale responses and queued frames as soon as the query changes, before debounce", async () => {
    render(<FileTree />);
    const old = await search();
    const lateHit = [...hitListeners][0]!;
    const lateMeta = [...metaListeners][0]!;
    stream(old, [hit("old.ts")]);
    stream(old, [hit("pending-old.ts")]);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "new query" } });
    expect(cancelSearch).toHaveBeenCalledWith(old.args.requestId);
    expect(screen.getByText("Waiting to search…")).toBeTruthy();
    expect(frames.size).toBe(0);
    act(() => {
      lateHit({ requestId: old.args.requestId!, hits: [hit("late-stream.ts")] });
      lateMeta({ requestId: old.args.requestId!, source: "scan" });
    });
    await finish(old, { hits: [hit("late-final.ts")], status: "failed" });
    expect(requests).toHaveLength(1);
    expect(screen.queryByText("old.ts")).toBeNull();
    expect(screen.queryByText("late-stream.ts")).toBeNull();
    expect(screen.queryByText("late-final.ts")).toBeNull();
    expect(screen.queryByLabelText("Search engine: scan")).toBeNull();
    expect(screen.getByText("Waiting to search…")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    const next = requests[1]!;
    expect(next.args.query).toBe("new query");
    await finish(next, { hits: [hit("new.ts")] });
    expect(screen.getByText("new.ts")).toBeTruthy();
  });

  it("preserves earlier pages and streamed next-page hits when Show more fails", async () => {
    render(<FileTree />);
    const first = await search();
    await finish(first, { hits: [hit("first-page.ts")], truncated: true });
    fireEvent.click(screen.getByRole("button", { name: /Show more/ }));
    const second = requests[1]!;
    expect(second.args.skipHits).toBe(1);
    stream(second, [hit("second-page.ts")]);
    stream(second, [hit("pending-page.ts")]);
    await act(async () => { second.reject(new Error("Read failed")); });
    expect(screen.getByText("first-page.ts")).toBeTruthy();
    expect(screen.getByText("second-page.ts")).toBeTruthy();
    expect(screen.getByText("pending-page.ts")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Search failed · 3 results in 3 files kept");
    expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();
  });

  it("only paginates partial results while the backend reports more matches", async () => {
    render(<FileTree />);
    const first = await search();
    await finish(first, { hits: [hit("first.ts")], status: "partial", truncated: true });
    fireEvent.click(screen.getByRole("button", { name: /Show more/ }));
    const next = requests[1]!;
    expect(next.args.skipHits).toBe(1);
    await finish(next, { hits: [hit("second.ts")], status: "partial", truncated: false });
    expect(screen.getByText("first.ts")).toBeTruthy();
    expect(screen.getByText("second.ts")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Search incomplete · 2 results in 2 files");
    expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();
  });

  it("ignores a rejected superseded request while the new search is still running", async () => {
    render(<FileTree />);
    const old = await search();
    const next = await search("replacement");
    engine(next, "rg");
    stream(next, [hit("current.ts")]);
    await act(async () => { old.reject(new Error("Stale host error")); });
    expect(screen.queryByText("Stale host error")).toBeNull();
    expect(screen.getByText("current.ts")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop search" })).toBeTruthy();
    expect(hitListeners.size).toBe(1);
    await finish(next, { hits: [hit("current.ts")] });
    expect(screen.getByRole("status").textContent).toContain("1 result in 1 file");
  });

  it("cancels and releases pending frames/listeners on workspace changes and unmount", async () => {
    const view = render(<FileTree />);
    const old = await search();
    stream(old, [hit("old.ts")]);
    stream(old, [hit("pending.ts")]);
    act(() => { useWorkspaceStore.setState({ workspaceRoot: "/other", workspaceName: "other" }); });
    expect(cancelSearch).toHaveBeenCalledWith(old.args.requestId);
    expect(frames.size).toBe(0);
    expect(hitListeners.size).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    const next = requests[1]!;
    expect(next.args.root).toBe("/other");
    await finish(old, { hits: [hit("late.ts")] });
    expect(screen.queryByText("late.ts")).toBeNull();
    expect(screen.getByRole("button", { name: "Stop search" })).toBeTruthy();
    stream(next, [hit("new.ts")]);
    stream(next, [hit("pending-new.ts")]);
    view.unmount();
    expect(cancelSearch).toHaveBeenCalledWith(next.args.requestId);
    expect(frames.size).toBe(0);
    expect(hitListeners.size).toBe(0);
    expect(metaListeners.size).toBe(0);
    await finish(next, { hits: [hit("late-new.ts")] });
  });
});
