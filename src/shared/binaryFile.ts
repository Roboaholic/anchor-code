const BINARY_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "icns",
  "bmp",
  "pdf",
  "zip",
  "gz",
  "tgz",
  "7z",
  "rar",
  "exe",
  "dll",
  "so",
  "dylib",
  "wasm",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "mp3",
  "mp4",
  "mov",
  "wav",
  "ogg",
  "webm",
  "class",
  "o",
  "a",
  "lib",
  "pdb",
  "sqlite",
  "db",
  "bin",
  "dat",
]);

export function extensionOf(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** True for known binary extensions. */
export function isBinaryExtension(path: string): boolean {
  return BINARY_EXT.has(extensionOf(path));
}

/** NUL byte or high ratio of non-text bytes → treat as binary. */
export function looksBinaryContent(text: string, sample = 8000): boolean {
  if (!text) return false;
  const slice = text.length > sample ? text.slice(0, sample) : text;
  if (slice.includes("\u0000")) return true;
  let weird = 0;
  for (let i = 0; i < slice.length; i++) {
    const c = slice.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 32 || c === 0xfffd) weird++;
  }
  return weird / slice.length > 0.1;
}

export function isBinaryFile(path: string, content?: string | null): boolean {
  if (isBinaryExtension(path)) return true;
  if (content != null && looksBinaryContent(content)) return true;
  return false;
}
