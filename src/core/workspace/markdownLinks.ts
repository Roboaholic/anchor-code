/**
 * Resolve link / image targets written inside a Markdown document.
 * Pure helpers (no host I/O) shared by the Markdown viewer.
 */

export type MarkdownTarget =
  /** `#heading` inside the current document. */
  | { kind: "anchor"; fragment: string }
  /** Web or mail link: open in the OS browser / mail client. */
  | { kind: "external"; url: string }
  /** File on the workspace host (forward slashes, host-native absolute path). */
  | { kind: "file"; path: string; fragment: string }
  /** Anything we must not follow (javascript:, data:, unknown schemes…). */
  | { kind: "blocked" };

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);

function extensionOf(filePath: string): string {
  const base = filePath.split(/[/\\]/).pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/** Formats the viewer can show through an `<img>` data URL. */
export function isPreviewableImagePath(filePath: string): boolean {
  return IMAGE_EXT.has(extensionOf(filePath));
}

export function isSvgPath(filePath: string): boolean {
  return extensionOf(filePath) === "svg";
}

/** Non-image binaries that would be garbage in a text viewer. */
export function isRasterImagePath(filePath: string): boolean {
  return isPreviewableImagePath(filePath) && !isSvgPath(filePath);
}

const DRIVE = /^[A-Za-z]:(\/|$)/;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // e.g. a literal "100%.svg" — keep it as written.
    return value;
  }
}

function splitRoot(p: string): { root: string; rest: string } {
  if (DRIVE.test(p)) return { root: `${p.slice(0, 2)}/`, rest: p.slice(3) };
  if (p.startsWith("//")) {
    // UNC: //server/share/…
    const parts = p.slice(2).split("/");
    const root = `//${parts.slice(0, 2).join("/")}/`;
    return { root, rest: parts.slice(2).join("/") };
  }
  if (p.startsWith("/")) return { root: "/", rest: p.slice(1) };
  return { root: "", rest: p };
}

/** Collapse `.` / `..` / duplicate separators without escaping the root. */
export function normalizeHostPath(input: string): string {
  const { root, rest } = splitRoot(input.replace(/\\/g, "/"));
  const out: string[] = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!root) out.push("..");
      continue;
    }
    out.push(part);
  }
  const joined = out.join("/");
  return root ? `${root}${joined}` || root : joined || ".";
}

function dirnameOf(filePath: string): string {
  const p = filePath.replace(/\\/g, "/");
  const slash = p.lastIndexOf("/");
  if (slash < 0) return ".";
  if (slash === 0) return "/";
  return p.slice(0, slash);
}

function stripQueryAndHash(href: string): { path: string; fragment: string } {
  const hash = href.indexOf("#");
  const fragment = hash >= 0 ? safeDecode(href.slice(hash + 1)) : "";
  let path = hash >= 0 ? href.slice(0, hash) : href;
  const query = path.indexOf("?");
  if (query >= 0) path = path.slice(0, query);
  return { path, fragment };
}

/**
 * Resolve `href` (as written in the Markdown at `documentPath`) to something
 * the app can act on. Relative paths resolve against the document's folder and
 * may use either separator, percent-encoding (`my%20file.svg`) or raw
 * non-ASCII names.
 */
export function resolveMarkdownTarget(documentPath: string, href: string | null | undefined): MarkdownTarget {
  const raw = (href ?? "").trim();
  if (!raw) return { kind: "blocked" };
  if (raw.startsWith("#")) return { kind: "anchor", fragment: safeDecode(raw.slice(1)) };

  const normalized = raw.replace(/\\/g, "/");
  if (!DRIVE.test(normalized) && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalized)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { kind: "blocked" };
    }
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") {
      return { kind: "external", url: url.toString() };
    }
    if (url.protocol === "file:") {
      let p = safeDecode(url.pathname);
      if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
      if (url.host) p = `//${url.host}${p}`;
      return { kind: "file", path: normalizeHostPath(p), fragment: safeDecode(url.hash.slice(1)) };
    }
    return { kind: "blocked" };
  }
  if (normalized.startsWith("//")) {
    // Protocol-relative web URL.
    return { kind: "external", url: `https:${normalized}` };
  }

  const { path, fragment } = stripQueryAndHash(normalized);
  if (!path) return { kind: "anchor", fragment };
  const decoded = path.split("/").map(safeDecode).join("/");
  const absolute = decoded.startsWith("/") || DRIVE.test(decoded)
    ? decoded
    : `${dirnameOf(documentPath)}/${decoded}`;
  return { kind: "file", path: normalizeHostPath(absolute), fragment };
}

/** `data:` URL for bytes returned by `workspace.readImage`. */
export function imageDataUrl(mime: string, base64: string): string {
  return `data:${mime};base64,${base64}`;
}
