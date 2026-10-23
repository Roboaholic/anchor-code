// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rankFuzzyPaths, type FuzzyMatch } from "@/core/workspace/fuzzy";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import { useShellStore } from "./shellStore";
import { QuickOpenPalette, applyFileIndexDelta, invalidateFileIndexCache, warmFileIndexCache } from "./QuickOpen";

const { search } = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock("./orchestrate", () => ({ openFileFromTree: vi.fn() }));
vi.mock("./fuzzySearchClient", () => ({ FuzzySearchClient: class {
  search = search;
  dispose() {}
} }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const index = (files: string[]) => ({ root: "/repo", files, truncated: false });
let findFiles: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invalidateFileIndexCache();
  findFiles = vi.fn(async () => index(["alpha.ts", "beta.ts"]));
  Object.assign(window, { anchor: { workspace: { findFiles } } });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  useWorkspaceStore.setState({ workspaceRoot: "/repo", hostKind: "local", hostProfileId: "local-default" });
  useShellStore.setState({ palette: "quickOpen" });
  search.mockReset().mockImplementation(async (paths: string[], query: string, limit: number) => rankFuzzyPaths(paths, query, limit));
});
afterEach(() => { cleanup(); invalidateFileIndexCache(); vi.restoreAllMocks(); });

describe("Quick Open responsiveness", () => {
  it("keeps a loading indicator through indexing and ranking without flashing an empty result", async () => {
    const scan = deferred<ReturnType<typeof index>>();
    const ranked = deferred<FuzzyMatch[]>();
    findFiles.mockReturnValue(scan.promise);
    render(<QuickOpenPalette />);
    expect(screen.getByRole("listbox").getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("status").querySelector(".codicon-loading")).toBeTruthy();
    expect(screen.queryByText("No matching files")).toBeNull();
    await act(async () => scan.resolve(index(["alpha.ts"])));
    await screen.findByRole("option", { name: /alpha.ts/ });
    await waitFor(() => expect(screen.getByRole("listbox").getAttribute("aria-busy")).toBe("false"));

    search.mockReturnValue(ranked.promise);
    fireEvent.change(screen.getByPlaceholderText("Search files by name…"), { target: { value: "missing" } });
    expect(screen.getByRole("status").textContent).toContain("Searching…");
    expect(screen.getByRole("status").querySelector(".codicon-loading")).toBeTruthy();
    expect(screen.queryByText("No matching files")).toBeNull();
    await act(async () => ranked.resolve([]));
    expect(screen.getByText("No matching files")).toBeTruthy();
    expect(screen.getByRole("listbox").getAttribute("aria-busy")).toBe("false");
    expect(screen.getByRole("status").querySelector(".codicon-loading")).toBeNull();
  });

  it("shares a pending workspace warm-up with the first palette opening", async () => {
    const pending = deferred<ReturnType<typeof index>>();
    findFiles.mockReturnValue(pending.promise);
    warmFileIndexCache("/repo");
    render(<QuickOpenPalette />);
    await waitFor(() => expect(findFiles).toHaveBeenCalledTimes(1));
    await act(async () => pending.resolve(index(["alpha.ts"])));
    expect(await screen.findByRole("option", { name: /alpha.ts/ })).toBeTruthy();
    expect(findFiles).toHaveBeenCalledTimes(1);
  });

  it("revalidates file creation during first warm-up and rejects its obsolete snapshot", async () => {
    const old = deferred<ReturnType<typeof index>>();
    const fresh = deferred<ReturnType<typeof index>>();
    findFiles.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    warmFileIndexCache("/repo");
    await waitFor(() => expect(findFiles).toHaveBeenCalledTimes(1));
    applyFileIndexDelta("/repo", [{ rel: "new.ts", exists: true }]);
    await waitFor(() => expect(findFiles).toHaveBeenCalledTimes(2));
    fresh.resolve(index(["new.ts"]));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    old.resolve(index(["old.ts"]));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    render(<QuickOpenPalette />);
    expect(await screen.findByRole("option", { name: /new.ts/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /old.ts/ })).toBeNull();
    expect(findFiles).toHaveBeenCalledTimes(2);
  });

  it("shows remote cached results before delayed revalidation completes", async () => {
    useWorkspaceStore.setState({ hostKind: "ssh", hostProfileId: "remote-a" });
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    warmFileIndexCache("/repo");
    await waitFor(() => expect(findFiles).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    now.mockReturnValue(7000);
    const pending = deferred<ReturnType<typeof index>>();
    findFiles.mockReturnValue(pending.promise);
    render(<QuickOpenPalette />);
    expect(await screen.findByRole("option", { name: /alpha.ts/ })).toBeTruthy();
    expect(findFiles).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status").querySelector(".codicon-loading")).toBeTruthy();
    await act(async () => pending.resolve(index(["fresh.ts"])));
    expect(await screen.findByRole("option", { name: /fresh.ts/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /alpha.ts/ })).toBeNull();
  });

  it("never displays an older query after a newer query has completed", async () => {
    const old = deferred<FuzzyMatch[]>();
    const latest = deferred<FuzzyMatch[]>();
    search.mockImplementation((paths: string[], query: string, limit: number) => {
      if (query === "alpha") return old.promise;
      if (query === "beta") return latest.promise;
      return Promise.resolve(rankFuzzyPaths(paths, query, limit));
    });
    render(<QuickOpenPalette />);
    await screen.findByRole("option", { name: /alpha.ts/ });
    const input = screen.getByPlaceholderText("Search files by name…");
    fireEvent.change(input, { target: { value: "alpha" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    fireEvent.change(input, { target: { value: "beta" } });
    await act(async () => latest.resolve(rankFuzzyPaths(["beta.ts"], "beta", 80)));
    await act(async () => old.resolve(rankFuzzyPaths(["alpha.ts"], "alpha", 80)));
    expect(screen.getByRole("option", { name: /beta/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /alpha/ })).toBeNull();
  });

  it("does not reuse results when another host has the same workspace path", async () => {
    render(<QuickOpenPalette />);
    await screen.findByRole("option", { name: /alpha.ts/ });
    const pending = deferred<ReturnType<typeof index>>();
    findFiles.mockReturnValue(pending.promise);
    act(() => useWorkspaceStore.setState({ hostKind: "ssh", hostProfileId: "remote-b" }));
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    await act(async () => pending.resolve(index(["remote.ts"])));
    expect(await screen.findByRole("option", { name: /remote.ts/ })).toBeTruthy();
  });
});
