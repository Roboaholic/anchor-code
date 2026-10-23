/**
 * Shell use-case orchestration — cross-feature flows only.
 */
import { resolveAnchor } from "@/core/annotations/anchor";
import {
  captureWorkspaceAnnotationsView,
  dropWorkspaceAnnotationsView,
  restoreWorkspaceAnnotationsView,
  useAnnotationsStore,
} from "@/features/annotations/annotationsStore";
import { joinPath } from "@/core/workspace/paths";

import {
  restoreCachedWorkspaceDocuments,
  dropWorkspaceDocumentView,
  restoreWorkspaceDocuments,
  flushDocumentAutosave,
  saveWorkspaceDocuments,
  useDocumentStore,
} from "@/features/document/documentStore";
import {
  captureWorkspaceHistoryView,
  dropWorkspaceHistoryView,
  restoreWorkspaceHistoryView,
  useHistoryStore,
} from "@/features/history/historyStore";
import {
  captureWorkspaceTerminalView,
  dropWorkspaceTerminalView,
  restoreWorkspaceTerminalView,
  restoreParkedWorkspaceAgents,
  saveWorkspaceAgents,
  useTerminalStore,
} from "@/features/terminal/terminalStore";
import { cancelWorkspaceNavigation, useWorkspaceStore } from "@/features/workspace/workspaceStore";
import type { CommentRecord, HostKind } from "@/shared/anchor-api";
import { formatError } from "@/shared/formatError";
import {
  captureWorkspaceShellView,
  dropWorkspaceShellView,
  restoreWorkspaceShellView,
  useShellStore,
} from "./shellStore";

/** Opens the Local / WSL chooser dialog (Windows) or local picker flow. */
export function openWorkspaceFromPicker(): void {
  useShellStore.getState().setOpenWorkspaceDialog(true);
}

export async function openWorkspaceWithHost(args: {
  path: string;
  hostProfileId: string;
  hostKind?: HostKind;
}): Promise<void> {
  await openWorkspacePath(args.path, args.hostProfileId);
}

function workspaceViewKey(root: string, hostProfileId: string | null): string {
  return `${hostProfileId ?? "local-default"}::${root.replace(/\\/g, "/").replace(/\/+$/, "")}`;
}

let workspaceOperation = 0;

function dropWorkspaceViews(root: string, hostProfileId: string | null): void {
  dropWorkspaceDocumentView(root, hostProfileId);
  dropWorkspaceHistoryView(root, hostProfileId);
  dropWorkspaceAnnotationsView(root);
  dropWorkspaceTerminalView(root, hostProfileId);
  dropWorkspaceShellView(workspaceViewKey(root, hostProfileId));
}
export async function openWorkspacePath(
  path: string,
  hostProfileId?: string,
): Promise<void> {
  const operation = ++workspaceOperation;
  try {
    const previous = useWorkspaceStore.getState();
    if (previous.workspaceRoot) {
      saveWorkspaceDocuments(previous.workspaceRoot, previous.hostProfileId);
      saveWorkspaceAgents(previous.workspaceRoot, previous.hostProfileId);
      captureWorkspaceHistoryView(previous.workspaceRoot, previous.hostProfileId);
      captureWorkspaceAnnotationsView(previous.workspaceRoot);
      captureWorkspaceTerminalView(previous.workspaceRoot, previous.hostProfileId);
      captureWorkspaceShellView(workspaceViewKey(previous.workspaceRoot, previous.hostProfileId));
    }
    await useWorkspaceStore.getState().openPath(path, { hostProfileId });
    if (operation !== workspaceOperation) return;
    const workspace = useWorkspaceStore.getState();
    if (workspace.workspaceRoot) {
      await afterWorkspaceOpened(workspace.workspaceRoot, workspace.hostProfileId);
    }
  } catch (err) {
    if (operation !== workspaceOperation) return;
    const message = formatError(err);
    console.error("[shell] openWorkspacePath failed:", err);
    useWorkspaceStore.setState({ status: "error", error: message });
  }
}

let launchRestoreStarted = false;

/**
 * Reopen the last active workspace once per app launch (setting "Restore last
 * workspace", default on). Main process probes reachability with a timeout;
 * any failure leaves the Welcome page as-is and never surfaces as an error.
 */
export async function restoreLastWorkspaceOnLaunch(): Promise<void> {
  if (launchRestoreStarted) return;
  launchRestoreStarted = true;
  try {
    const target = await window.anchor?.workspace?.getRestoreTarget?.();
    if (!target) return;
    // The user may have opened something while we probed.
    if (useWorkspaceStore.getState().workspaceRoot) return;
    await openWorkspacePath(target.path, target.hostProfileId);
    const ws = useWorkspaceStore.getState();
    if (!ws.workspaceRoot && ws.status === "error") {
      console.warn("[shell] restore last workspace failed:", ws.error);
      useWorkspaceStore.setState({ status: "idle", error: null });
    }
  } catch (err) {
    console.warn("[shell] restore last workspace skipped:", err);
  }
}

export async function activateWorkspace(id: string): Promise<void> {
  const operation = ++workspaceOperation;
  try {
    const previous = useWorkspaceStore.getState();
    if (previous.workspaceRoot) {
      saveWorkspaceDocuments(previous.workspaceRoot, previous.hostProfileId);
      saveWorkspaceAgents(previous.workspaceRoot, previous.hostProfileId);
      captureWorkspaceHistoryView(previous.workspaceRoot, previous.hostProfileId);
      captureWorkspaceAnnotationsView(previous.workspaceRoot);
      captureWorkspaceTerminalView(previous.workspaceRoot, previous.hostProfileId);
      captureWorkspaceShellView(workspaceViewKey(previous.workspaceRoot, previous.hostProfileId));
    }

    await useWorkspaceStore.getState().activateWorkspace(id);
    if (operation !== workspaceOperation) return;
    const workspace = useWorkspaceStore.getState();
    if (!workspace.workspaceRoot) return;

    const restoredDocuments = restoreCachedWorkspaceDocuments(
      workspace.workspaceRoot,
      workspace.hostProfileId,
    );
    if (!restoredDocuments) {
      await restoreWorkspaceDocuments(workspace.workspaceRoot, workspace.hostProfileId);
    }
    if (operation !== workspaceOperation) return;

    restoreWorkspaceHistoryView(workspace.workspaceRoot, workspace.hostProfileId);
    restoreWorkspaceAnnotationsView(workspace.workspaceRoot);

    const restoredTerminal = restoreWorkspaceTerminalView(
      workspace.workspaceRoot,
      workspace.hostProfileId,
    );
    if (!restoredTerminal) {
      await useTerminalStore.getState().resetForWorkspace(
        workspace.workspaceRoot,
        workspace.hostProfileId,
        () => operation === workspaceOperation,
      );
    }
    if (operation !== workspaceOperation) return;
    restoreParkedWorkspaceAgents(
      workspace.workspaceRoot,
      workspace.hostProfileId,
    );

    const key = workspaceViewKey(workspace.workspaceRoot, workspace.hostProfileId);
    restoreWorkspaceShellView(key);
  } catch (err) {
    if (operation !== workspaceOperation) return;
    const message = formatError(err);
    console.error("[shell] activateWorkspace failed:", err);
    useWorkspaceStore.setState({ status: "error", error: message });
  }
}
/**
 * Close an open workspace from the switcher. Closing the current one switches
 * to the most recently active remaining workspace, or to the empty state.
 */
export async function closeWorkspace(id: string): Promise<void> {
  const closing = useWorkspaceStore.getState();
  const operation = closing.activeWorkspaceId === id ? ++workspaceOperation : workspaceOperation;
  const target = closing.openWorkspaces.find((workspace) => workspace.id === id);
  try {
    if (closing.activeWorkspaceId === id && closing.workspaceRoot) {
      cancelWorkspaceNavigation();
      // Capture before awaiting IPC: another workspace can be selected meanwhile.
      flushDocumentAutosave();
      saveWorkspaceDocuments(closing.workspaceRoot, closing.hostProfileId);
      saveWorkspaceAgents(closing.workspaceRoot, closing.hostProfileId);
    }
    const res = await window.anchor.workspace.close(id);
    useWorkspaceStore.setState((s) => {
      const views = { ...s.workspaceViews };
      delete views[id];
      return {
        workspaceViews: views,
        openWorkspaces: s.openWorkspaces.filter((w) => w.id !== id),
      };
    });
    if (target) dropWorkspaceViews(target.root, target.hostProfileId);
    if (operation !== workspaceOperation) return;
    if (!res.wasActive) {
      await useWorkspaceStore.getState().loadOpenWorkspaces();
      return;
    }
    // Drop the closed root first so activateWorkspace does not re-save its views.
    useWorkspaceStore.setState({
      workspaceRoot: null,
      workspaceName: null,
      rootEntries: [],
      selectedPath: null,
      status: "idle",
      error: null,
    });
    if (res.nextActiveId) {
      await activateWorkspace(res.nextActiveId);
      return;
    }
    useWorkspaceStore.setState({
      activeWorkspaceId: null,
      hostKind: null,
      hostProfileId: null,
    });
    useDocumentStore.getState().closeAllItems();
    useHistoryStore.getState().reset();
    useAnnotationsStore.getState().reset();
    useShellStore.getState().setLeftMode("files");
    await useWorkspaceStore.getState().loadOpenWorkspaces();
  } catch (err) {
    console.error("[shell] closeWorkspace failed:", err);
    await useWorkspaceStore.getState().loadOpenWorkspaces();
  }
}

async function afterWorkspaceOpened(
  root: string,
  hostProfileId: string | null,
): Promise<void> {
  const operation = workspaceOperation;
  const isCurrent = () => operation === workspaceOperation &&
    useWorkspaceStore.getState().workspaceRoot === root &&
    useWorkspaceStore.getState().hostProfileId === hostProfileId;
  useHistoryStore.getState().reset();
  useAnnotationsStore.getState().reset();
  useShellStore.getState().setLeftMode("files");
  useShellStore.getState().setAgentVisible(false);
  useShellStore.getState().setTerminalVisible(false);
  useShellStore.getState().setSkillInstallPromptRoot(null);
  await restoreWorkspaceDocuments(root, hostProfileId);
  if (!isCurrent()) return;
  // The active document is ready. Independent auxiliary work can run together,
  // and each asynchronous path discards results after a workspace transition.
  void useHistoryStore.getState().discover(root, { isCurrent }).catch((err: unknown) => {
    console.warn("[shell] history.discover failed:", err);
  });
  void useTerminalStore.getState().resetForWorkspace(root, hostProfileId, isCurrent).then(() => {
    if (isCurrent()) restoreParkedWorkspaceAgents(root, hostProfileId);
  }).catch((err: unknown) => {
    console.warn("[shell] terminal workspace restore failed:", err);
  });
  void (async () => {
    try {
      const installed = (await window.anchor?.skill?.isWorkspaceInstalled?.(root)) ?? false;
      if (isCurrent() && !installed) useShellStore.getState().setSkillInstallPromptRoot(root);
    } catch (err) {
      console.warn("[shell] skill install check failed:", err);
    }
  })();
}

export async function openFileFromTree(
  path: string,
  opts?: {
    revealLine?: number;
    searchHighlight?: {
      line: number;
      query: string;
      useRegex?: boolean;
      caseSensitive?: boolean;
    } | null;
  },
): Promise<void> {
  const root = useWorkspaceStore.getState().workspaceRoot;
  useWorkspaceStore.getState().setSelectedPath(path);
  await useDocumentStore.getState().openFile({
    path,
    workspaceRoot: root,
    revealLine: opts?.revealLine ?? opts?.searchHighlight?.line,
    searchHighlight: opts?.searchHighlight,
  });
  // Sessions are anchored to the workspace root (cross-repo comments).
  try {
    if (root) await useAnnotationsStore.getState().loadForRepo(root);
  } catch {
    // non-fatal
  }
}

/** Explicit Start Compare — never auto-focus middle on selection alone. */
export async function openHistoryCompare(repoRoot: string): Promise<void> {
  const payload = await useHistoryStore.getState().runCompare(repoRoot);
  if (payload) {
    useDocumentStore.getState().openDiff(payload);
  }
}

export async function openHistoryRecent(
  entry: import("@/shared/anchor-api").HistoryCompareEntry,
): Promise<void> {
  const payload = await useHistoryStore.getState().openRecentCompare(entry);
  if (payload) {
    useDocumentStore.getState().openDiff(payload);
  }
}

/**
 * Open a single-file Diff for History → Changes (HEAD → worktree).
 * Focus layout: no CHANGED FILES sidebar; comments work in side-by-side.
 */
export async function openWorkingTreeFileDiff(
  repoRoot: string,
  relativePath: string,
  status: string,
): Promise<void> {
  const name = relativePath.split(/[/\\]/).pop() || relativePath;
  useDocumentStore.getState().openDiff({
    repoRoot,
    base: "HEAD",
    head: "worktree",
    title: `${name} · ${status}`,
    files: [{ path: relativePath, status: status || "M" }],
    activeFilePath: relativePath,
    hideFileList: true,
  });
}

export async function openWorktreeFileFromDiff(
  repoRoot: string,
  relativePath: string,
): Promise<void> {
  const abs = joinPath(repoRoot, relativePath);
  const workspaceRoot = useWorkspaceStore.getState().workspaceRoot;
  await useDocumentStore.getState().openFile({
    path: abs,
    workspaceRoot,
  });
}

export async function addCommentFromSelection(input: {
  filePath: string;
  kind: "source" | "markdown";
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  selectedText: string;
  beforeContext: string;
  afterContext: string;
  lineText?: string;
  body: string;
  /** Initial status for the new comment (default discussing). */
  status?: CommentRecord["status"];
  /** End current session (export) and open a fresh one before saving. */
  forceNewSession?: boolean;
}): Promise<void> {
  // Sessions are anchored to the workspace root (cross-repo comments), not to
  // any git repository root.
  const repoRoot = useWorkspaceStore.getState().workspaceRoot;
  if (!repoRoot) {
    useAnnotationsStore.setState({
      toast: "No workspace open",
    });
    throw new Error("No workspace open");
  }
  const store = useAnnotationsStore.getState();
  if (store.repoRoot !== repoRoot) {
    await store.loadForRepo(repoRoot);
  }
  if (input.forceNewSession) {
    await useAnnotationsStore.getState().startFreshSession(repoRoot);
  }
  await useAnnotationsStore.getState().addComment({
    repoRoot,
    filePath: input.filePath,
    kind: input.kind,
    startLine: input.startLine,
    endLine: input.endLine,
    startColumn: input.startColumn,
    endColumn: input.endColumn,
    selectedText: input.selectedText,
    beforeContext: input.beforeContext,
    afterContext: input.afterContext,
    lineText: input.lineText,
    body: input.body,
    status: input.status,
  });
}

/**
 * Open a sidebar comment's file and focus its session decorations.
 * The session id is supplied by the sidebar to avoid ambiguous/racy lookup.
 */
export async function jumpToComment(
  comment: CommentRecord,
  sessionId?: string,
): Promise<void> {
  const ann = useAnnotationsStore.getState();
  const repoRoot = ann.repoRoot;
  if (!repoRoot) return;

  const ownerId =
    sessionId ??
    ann.sessions.find((s) => s.comments.some((c) => c.id === comment.id))?.id;
  if (ownerId) {
    // Keep the owning session expanded in the sidebar.
    useAnnotationsStore.getState().setExpandedSession(ownerId);
  }

  const abs = joinPath(repoRoot, comment.target.file_path).replace(/\\/g, "/");
  const workspaceRoot = useWorkspaceStore.getState().workspaceRoot;
  let revealLine = comment.target.start_line;
  try {
    const text = await window.anchor.workspace.readText(abs);
    const resolved = resolveAnchor(text.text, comment.target);
    if (resolved.status !== "unresolved") {
      revealLine = resolved.startLine;
    }
  } catch {
    // keep stored line
  }
  await useDocumentStore.getState().openFile({
    path: abs,
    workspaceRoot,
    revealLine,
    focusCommentId: comment.id,
  });
  // For markdown, switch to raw for line reveal + annotation visibility
  const item = useDocumentStore
    .getState()
    .openItems.find(
      (i) =>
        i.kind === "file" &&
        i.path.replace(/\\/g, "/") === abs.replace(/\\/g, "/"),
    );
  if (item && item.kind === "file" && item.isMarkdown) {
    useDocumentStore.getState().setMdViewMode(item.id, "raw");
  }
}
