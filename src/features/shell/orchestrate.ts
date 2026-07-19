/**
 * Shell use-case orchestration — cross-feature flows only.
 */
import { useAnnotationsStore } from "@/features/annotations/annotationsStore";
import { useDocumentStore } from "@/features/document/documentStore";
import { useHistoryStore } from "@/features/history/historyStore";
import { useTerminalStore } from "@/features/terminal/terminalStore";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import { joinPath } from "@/core/workspace/paths";
import type { CommentRecord } from "@/shared/anchor-api";

export async function openWorkspaceFromPicker(): Promise<void> {
  try {
    if (!window.anchor?.workspace?.pickFolder) {
      throw new Error(
        "IPC bridge missing. Run via Electron (`npm run dev`), not a browser tab.",
      );
    }
    const picked = await window.anchor.workspace.pickFolder();
    if (!picked) return; // user cancelled — leave UI as-is
    await useWorkspaceStore.getState().openPath(picked);
    const root = useWorkspaceStore.getState().workspaceRoot;
    if (root) await afterWorkspaceOpened(root);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[shell] openWorkspaceFromPicker failed:", err);
    useWorkspaceStore.setState({ status: "error", error: message });
  }
}

export async function openWorkspacePath(path: string): Promise<void> {
  try {
    await useWorkspaceStore.getState().openPath(path);
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

export async function runHistoryCompare(): Promise<void> {
  const payload = await useHistoryStore.getState().runCompare();
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
  body: string;
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
    body: input.body,
  });
}

export async function jumpToComment(comment: CommentRecord): Promise<void> {
  const repoRoot = useAnnotationsStore.getState().repoRoot;
  if (!repoRoot) return;
  const abs = joinPath(repoRoot, comment.target.file_path);
  const workspaceRoot = useWorkspaceStore.getState().workspaceRoot;
  await useDocumentStore.getState().openFile({
    path: abs,
    workspaceRoot,
    revealLine: comment.target.start_line,
  });
  // For markdown, switch to raw for line reveal + annotation visibility
  const item = useDocumentStore
    .getState()
    .openItems.find((i) => i.kind === "file" && i.path === abs);
  if (item && item.kind === "file" && item.isMarkdown) {
    useDocumentStore.getState().setMdViewMode(item.id, "raw");
  }
}
