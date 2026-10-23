import type { AnchorApi } from "@/shared/anchor-api";

type FileChangeEvent = Parameters<Parameters<AnchorApi["workspace"]["onFileChange"]>[0]>[0];

/** Filename indexes and tree entries do not change when only file contents change. */
export function planFileChanges(event: FileChangeEvent): {
  refreshTree: boolean;
  rebuildIndex: boolean;
  deltas: { rel: string; exists: boolean }[];
} {
  if (!event.changes?.length) return { refreshTree: true, rebuildIndex: true, deltas: [] };
  const deltas: { rel: string; exists: boolean }[] = [];
  let refreshTree = false;
  let rebuildIndex = false;
  for (const change of event.changes) {
    const name = change.rel.replace(/\\/g, "/").split("/").at(-1);
    if (name === ".anchorignore" || name === ".gitignore") rebuildIndex = true;
    if (change.eventType !== "rename") continue;
    refreshTree = true;
    if (change.kind === "file" || change.kind === "missing") {
      deltas.push({ rel: change.rel, exists: change.kind === "file" });
    } else {
      // Directory additions can contain an entire subtree. Unknown/legacy
      // events need one refreshed index, never N renderer-to-main stat calls.
      rebuildIndex = true;
    }
  }
  return { refreshTree, rebuildIndex, deltas };
}
