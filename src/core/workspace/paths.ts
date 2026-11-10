/** Pure path / language helpers for workspace + document (no host I/O). */

const IGNORED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".DS_Store",
]);

/** Names that should not appear as expandable tree children. */
export function shouldHideTreeEntry(name: string, type: "file" | "dir"): boolean {
  if (name === ".DS_Store") return true;
  if (type === "dir" && name === "node_modules") return true;
  // Show .git as a leaf-ish: we still list the name but never expand contents.
  return false;
}

/** Directories we list as a node but do not load children for. */
export function shouldSkipExpand(name: string): boolean {
  return name === "node_modules" || name === ".git" || IGNORED_DIR_NAMES.has(name);
}

export function basename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || filePath;
}

export function joinPath(parent: string, name: string): string {
  if (parent.endsWith("/") || parent.endsWith("\\")) {
    return parent + name;
  }
  // Prefer POSIX for display consistency; host resolves on Local via OS.
  const sep = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  return `${parent}${sep}${name}`;
}

export function relativeToRoot(root: string, absolutePath: string): string {
  const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const p = absolutePath.replace(/\\/g, "/");
  if (p === r) return "";
  if (p.startsWith(r + "/")) return p.slice(r.length + 1);
  return absolutePath;
}

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  mdx: "markdown",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  sql: "sql",
  graphql: "graphql",
  vue: "html",
  svelte: "html",
  txt: "plaintext",
  env: "plaintext",
  gitignore: "plaintext",
  dockerfile: "dockerfile",
};

export function languageFromPath(filePath: string): string {
  const base = basename(filePath).toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile") return "plaintext";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "plaintext";
  const ext = base.slice(dot + 1);
  return EXT_LANG[ext] ?? "plaintext";
}

export function isMarkdownPath(filePath: string): boolean {
  const base = basename(filePath).toLowerCase();
  return base.endsWith(".md") || base.endsWith(".mdx") || base.endsWith(".markdown");
}

export function workspaceDisplayName(root: string): string {
  return basename(root) || root;
}

/** Compare paths ignoring backslash vs slash so Local (Windows) and SSH/WSL keys match. */
export function pathsEqual(a: string, b: string): boolean {
  return a.replace(/\\/g, "/") === b.replace(/\\/g, "/");
}

/** True when `path` is the workspace root or a file/dir inside it. */
export function isPathInsideRoot(root: string, path: string): boolean {
  const r = root.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const p = path.replace(/\\/g, "/");
  return p === r || p.startsWith(r + "/");
}

/**
 * POSIX-normalized directory keys from the workspace root down to the file's
 * parent (excluding the root itself and the file). Empty when the file sits
 * directly under the root, or when it is outside the workspace.
 */
export function ancestorDirKeys(root: string, filePath: string): string[] {
  const r = root.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const p = filePath.replace(/\\/g, "/");
  if (p === r || !p.startsWith(r + "/")) return [];
  const parts = p.slice(r.length + 1).split("/").filter(Boolean);
  if (parts.length <= 1) return [];
  const dirs: string[] = [];
  let acc = r;
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc === "/" ? `/${parts[i]}` : `${acc}/${parts[i]}`;
    dirs.push(acc);
  }
  return dirs;
}
