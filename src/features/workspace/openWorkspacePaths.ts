/** Pure path helpers for Open Workspace dialog (POSIX browse). */

export function parentPosix(path: string): string | null {
  if (!path || path === "/") return null;
  const trimmed = path.replace(/\/+$/, "") || "/";
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx) || "/";
}

export function joinPosix(parent: string, name: string): string {
  if (parent === "/") return `/${name}`;
  return `${parent.replace(/\/+$/, "")}/${name}`;
}

const HIDDEN = new Set([".", ".."]);

export function filterBrowseDirs(
  entries: { name: string; type: "file" | "dir" }[],
): { name: string; type: "file" | "dir" }[] {
  return entries
    .filter(
      (e) =>
        e.type === "dir" &&
        !HIDDEN.has(e.name) &&
        !e.name.startsWith("."),
    )
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
}

/** Detect Windows renderer (Electron userAgent includes Windows). */
export function isWindowsClient(
  userAgent: string = typeof navigator !== "undefined" ? navigator.userAgent : "",
): boolean {
  return /windows/i.test(userAgent);
}
