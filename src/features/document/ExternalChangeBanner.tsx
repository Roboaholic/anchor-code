import { useDocumentStore } from "./documentStore";

/**
 * Inline prompt when a dirty tab's file changed on disk.
 * Reload = take disk (overwrite buffer). Keep mine = dismiss this change.
 */
export function ExternalChangeBanner({ path }: { path: string }) {
  const externalChange = useDocumentStore((s) => {
    const item = s.openItems.find((i) => i.kind === "file" && i.path === path);
    return item && item.kind === "file" ? item.externalChange : null;
  });
  const reloadFileFromDisk = useDocumentStore((s) => s.reloadFileFromDisk);
  const keepFileBuffer = useDocumentStore((s) => s.keepFileBuffer);

  if (!externalChange) return null;

  return (
    <div className="banner banner--warn file-external-change" role="status">
      <span className="file-external-change__label">
        This file changed on disk. Reload to take the disk version, or keep your buffer.
      </span>
      <div className="file-external-change__actions">
        <button
          type="button"
          className="btn btn--fill btn--small"
          onClick={() => void reloadFileFromDisk(path)}
        >
          Reload
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--small"
          onClick={() => keepFileBuffer(path)}
        >
          Keep mine
        </button>
      </div>
    </div>
  );
}
