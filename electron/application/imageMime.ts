/** Raster/vector formats the renderer may show through `<img>` data URLs. */
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

export function imageMimeType(filePath: string): string | null {
  const base = filePath.split(/[/\\]/).pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  return IMAGE_MIME[base.slice(dot + 1).toLowerCase()] ?? null;
}
