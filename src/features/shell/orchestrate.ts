/**
 * Shell use-case orchestration — features do not import each other's stores freely;
 * cross-feature flows go through shell helpers.
 */
import { useDocumentStore } from "@/features/document/documentStore";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";

export async function openWorkspaceFromPicker(): Promise<void> {
  await useWorkspaceStore.getState().pickAndOpen();
  if (useWorkspaceStore.getState().workspaceRoot) {
    useDocumentStore.getState().closeAllFiles();
  }
}

export async function openWorkspacePath(path: string): Promise<void> {
  await useWorkspaceStore.getState().openPath(path);
  useDocumentStore.getState().closeAllFiles();
}

export async function openFileFromTree(path: string): Promise<void> {
  const root = useWorkspaceStore.getState().workspaceRoot;
  useWorkspaceStore.getState().setSelectedPath(path);
  await useDocumentStore.getState().openFile({ path, workspaceRoot: root });
}
