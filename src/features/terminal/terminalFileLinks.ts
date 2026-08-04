export interface TerminalFileLink {
  text: string;
  path: string;
  line?: number;
  column?: number;
  startIndex: number;
  endIndex: number;
}

export interface TerminalFileLinkRange {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

/** Map a link in a joined soft-wrapped line back to xterm buffer coordinates. */
export function terminalFileLinkRange(
  link: TerminalFileLink,
  firstRow: number,
  columns: number,
): TerminalFileLinkRange {
  const endIndex = Math.max(link.startIndex, link.endIndex - 1);
  return {
    start: {
      x: (link.startIndex % columns) + 1,
      y: firstRow + Math.floor(link.startIndex / columns),
    },
    end: {
      x: (endIndex % columns) + 1,
      y: firstRow + Math.floor(endIndex / columns),
    },
  };
}

const TOKEN_RE = /[^\s`"'<>]+/g;
const TRAILING_PUNCTUATION = /[),;!?}\]]+$/;
const LEADING_PUNCTUATION = /^[([{]+/;
const FILE_NAME_RE = /(?:^|[\\/])(?:[^\\/]+\.[A-Za-z0-9][A-Za-z0-9_-]*|Dockerfile|Makefile|README|LICENSE)$/i;

/** Extract file references from one rendered terminal row. Indices are UTF-16 offsets. */
export function findTerminalFileLinks(text: string): TerminalFileLink[] {
  const links: TerminalFileLink[] = [];

  for (const match of text.matchAll(TOKEN_RE)) {
    const raw = match[0];
    const rawStart = match.index ?? 0;
    const leading = raw.match(LEADING_PUNCTUATION)?.[0].length ?? 0;
    let token = raw.slice(leading).replace(TRAILING_PUNCTUATION, "");
    if (!token || /^(?:https?|file):\/\//i.test(token)) continue;

    let line: number | undefined;
    let column: number | undefined;
    const hashLocation = token.match(/#L(\d+)(?:C(\d+))?$/i);
    const colonLocation = token.match(/:(\d+)(?::(\d+))?$/);
    const location = hashLocation ?? colonLocation;
    if (location) {
      line = Number(location[1]);
      column = location[2] ? Number(location[2]) : undefined;
      token = token.slice(0, -location[0].length);
    }

    if (!FILE_NAME_RE.test(token)) continue;
    const textLength = token.length + (location?.[0].length ?? 0);
    const startIndex = rawStart + leading;
    links.push({
      text: raw.slice(leading, leading + textLength),
      path: token,
      line,
      column,
      startIndex,
      endIndex: startIndex + textLength,
    });
  }

  return links;
}

export function resolveTerminalFilePath(workspaceRoot: string, filePath: string): string {
  if (/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(filePath)) return filePath;
  const separator = workspaceRoot.includes("\\") && !workspaceRoot.includes("/") ? "\\" : "/";
  return `${workspaceRoot.replace(/[\\/]$/, "")}${separator}${filePath.replace(/^\.?[\\/]/, "")}`;
}
