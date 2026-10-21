/** Strip Electron IPC / Error prefixes; keep the first useful line. */
export function formatError(err: unknown): string {
  let raw =
    err instanceof Error
      ? err.message || err.name || "Something went wrong"
      : typeof err === "string"
        ? err
        : err == null
          ? "Something went wrong"
          : String(err);

  raw = raw.replace(/\r\n/g, "\n").trim();
  if (!raw) return "Something went wrong";

  // Electron: Error invoking remote method 'x': Error: actual message
  raw = raw.replace(
    /^Error invoking remote method '[^']+':\s*/i,
    "",
  );
  raw = raw.replace(/^Error:\s*/i, "");
  // Nested "Error: Error: …"
  raw = raw.replace(/^(?:Error:\s*)+/i, "");

  const firstLine = raw.split("\n").map((l) => l.trim()).find(Boolean);
  return firstLine || "Something went wrong";
}
