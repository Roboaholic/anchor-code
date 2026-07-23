/**
 * Shell use-case orchestration — cross-feature flows only.
 */
import { resolveAnchor } from "@/core/annotations/anchor";
import { joinPath } from "@/core/workspace/paths";
import { useAnnotationsStore } from "@/features/annotations/annotationsStore";
import { useDocumentStore } from "@/features/document/documentStore";
import { useHistoryStore } from "@/features/history/historyStore";
import { useTerminalStore } from "@/features/terminal/terminalStore";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import type { CommentRecord, HostKind } from "@/shared/anchor-api";
import { useShellStore } from "./shellStore";

/** Opens the Local / WSL chooser dialog (Windows) or local picker flow. */
export function openWorkspaceFromPicker(): void {
  useShellStore.getState().setOpenWorkspaceDialog(true);
}

export async function openWorkspaceWithHost(args: {
  path: string;
  hostProfileId: string;
  hostKind?: HostKind;
}): Promise<void> {
  try {
    await useWorkspaceStore.getState().openPath(args.path, {
      hostProfileId: args.hostProfileId,
    });
    const root = useWorkspaceStore.getState().workspaceRoot;
    if (root) await afterWorkspaceOpened(root);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[shell] openWorkspaceWithHost failed:", err);
    useWorkspaceStore.setState({ status: "error", error: message });
  }
}

export async function openWorkspacePath(
  path: string,
  hostProfileId?: string,
): Promise<void> {
  try {
    await useWorkspaceStore.getState().openPath(path, { hostProfileId });
    const root = useWorkspaceStore.getState().workspaceRoot;
    if (root) await afterWorkspaceOpened(root);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[shell] openWorkspacePath failed:", err);
    useWorkspaceStore.setState({ status: "error", error: message });
  }
}

async function afterWorkspaceOpened(root: string): Promise<void> {
  useDocumentStore.getState().closeAllFiles();
  useHistoryStore.getState().reset();
  useAnnotationsStore.getState().reset();
  // History / terminal must not block a successful workspace open.
  try {
    await useHistoryStore.getState().discover(root);
  } catch (err) {
    console.warn("[shell] history.discover failed:", err);
  }
  try {
    await useTerminalStore.getState().resetForWorkspace(root);
  } catch (err) {
    console.warn("[shell] terminal.resetForWorkspace failed:", err);
  }
}

export async function openFileFromTree(path: string): Promise<void> {
  const root = useWorkspaceStore.getState().workspaceRoot;
  useWorkspaceStore.getState().setSelectedPath(path);
  await useDocumentStore.getState().openFile({ path, workspaceRoot: root });
  // load annotations for file's repo
  try {
    const repo = await window.anchor.annotations.locateGitRoot(path);
    if (repo) await useAnnotationsStore.getState().loadForRepo(repo);
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
  /** End current session (export) and open a fresh one before saving. */
  forceNewSession?: boolean;
}): Promise<void> {
  const repoRoot = await window.anchor.annotations.locateGitRoot(
    input.filePath,
  );
  if (!repoRoot) {
    useAnnotationsStore.setState({
      toast: "File is not inside a git repository",
    });
    throw new Error("No git root for file");
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
  });
}

export async function jumpToComment(comment: CommentRecord): Promise<void> {
  const repoRoot = useAnnotationsStore.getState().repoRoot;
  if (!repoRoot) return;
  const abs = joinPath(repoRoot, comment.target.file_path);
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
  });
  // For markdown, switch to raw for line reveal + annotation visibility
  const item = useDocumentStore
    .getState()
    .openItems.find((i) => i.kind === "file" && i.path === abs);
  if (item && item.kind === "file" && item.isMarkdown) {
    useDocumentStore.getState().setMdViewMode(item.id, "raw");
  }
}
