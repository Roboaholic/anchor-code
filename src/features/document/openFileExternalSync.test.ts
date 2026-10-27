// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDocumentStore } from "./documentStore";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import {
  OPEN_FILE_SYNC_DEBOUNCE_MS,
  checkOpenFilesAgainstDisk,
  openPathsTouchedByWatchEvent,
  startOpenFileExternalSync,
} from "./openFileExternalSync";

const readText = vi.fn();
const stat = vi.fn();
type Listener = (event: {
  root?: string;
  hostProfileId?: string;
  dir: string;
  changes?: { path: string; rel: string; eventType: string; kind?: string }[];
}) => void;
const listeners: Listener[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  listeners.length = 0;
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  readText.mockReset().mockImplementation(async (path: string) => ({
    text: `content:${path}`,
    size: 10,
    truncated: false,
  }));
  stat.mockReset().mockResolvedValue({ isFile: true, isDir: false, size: 10, mtimeMs: 1_000 });
  Object.assign(window, {
    anchor: {
      workspace: {
        readText,
        stat,
        onFileChange: (cb: Listener) => {
          listeners.push(cb);
          return () => {
            const i = listeners.indexOf(cb);
            if (i >= 0) listeners.splice(i, 1);
          };
        },
      },
    },
  });
  useDocumentStore.setState(useDocumentStore.getInitialState(), true);
  useWorkspaceStore.setState({
    ...useWorkspaceStore.getInitialState(),
    workspaceRoot: "/repo",
    hostKind: "local",
    hostProfileId: "local-default",
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("openPathsTouchedByWatchEvent", () => {
  it("matches content and rename events for open tabs", () => {
    expect(
      openPathsTouchedByWatchEvent(
        {
          dir: "/repo",
          changes: [
            { path: "/repo/a.ts", rel: "a.ts", eventType: "change" },
            { path: "/repo/b.ts", rel: "b.ts", eventType: "rename", kind: "file" },
            { path: "/repo/c.ts", rel: "c.ts", eventType: "change" },
          ],
        },
        ["/repo/a.ts", "/repo/b.ts"],
      ),
    ).toEqual(["/repo/a.ts", "/repo/b.ts"]);
  });
});

describe("startOpenFileExternalSync", () => {
  it("reloads a clean open tab after a local watch content event", async () => {
    await useDocumentStore.getState().openFile({ path: "/repo/a.ts", workspaceRoot: "/repo" });
    const stop = startOpenFileExternalSync();
    readText.mockResolvedValue({ text: "from watch", size: 9, truncated: false });
    stat.mockResolvedValue({ isFile: true, isDir: false, size: 9, mtimeMs: 2_000 });
    for (const listener of listeners) {
      listener({
        root: "/repo",
        hostProfileId: "local-default",
        dir: "/repo",
        changes: [{ path: "/repo/a.ts", rel: "a.ts", eventType: "change" }],
      });
    }
    await vi.advanceTimersByTimeAsync(OPEN_FILE_SYNC_DEBOUNCE_MS);
    await vi.waitFor(() => {
      expect(useDocumentStore.getState().openItems.find((i) => i.kind === "file")).toMatchObject({
        content: "from watch",
        diskMtimeMs: 2_000,
      });
    });
    stop();
  });

  it("polls open tabs on remote hosts", async () => {
    useWorkspaceStore.setState({ hostKind: "ssh", hostProfileId: "ssh-1" });
    await useDocumentStore.getState().openFile({ path: "/repo/a.ts", workspaceRoot: "/repo" });
    const stop = startOpenFileExternalSync();
    readText.mockResolvedValue({ text: "from poll", size: 8, truncated: false });
    stat.mockResolvedValue({ isFile: true, isDir: false, size: 8, mtimeMs: 9_000 });
    await vi.advanceTimersByTimeAsync(3_000);
    await Promise.resolve();
    await vi.waitFor(() => {
      expect(useDocumentStore.getState().openItems.find((i) => i.kind === "file")).toMatchObject({
        content: "from poll",
        diskMtimeMs: 9_000,
      });
    });
    stop();
  });
});

describe("checkOpenFilesAgainstDisk", () => {
  it("ignores unchanged fingerprints", async () => {
    await useDocumentStore.getState().openFile({ path: "/repo/a.ts", workspaceRoot: "/repo" });
    const calls = readText.mock.calls.length;
    await checkOpenFilesAgainstDisk(["/repo/a.ts"]);
    expect(readText).toHaveBeenCalledTimes(calls);
  });
});
