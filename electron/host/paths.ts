import path from "node:path";
import type { HostKind } from "./types.js";

/** True when execution-end paths are POSIX (WSL / SSH). */
export function isPosixHost(kind: HostKind): boolean {
  return kind === "wsl" || kind === "ssh";
}

export function hostJoin(kind: HostKind, ...parts: string[]): string {
  if (isPosixHost(kind)) {
    return path.posix.join(...parts);
  }
  return path.join(...parts);
}

export function hostBasename(kind: HostKind, p: string): string {
  if (isPosixHost(kind)) {
    return path.posix.basename(p) || p;
  }
  return path.basename(p) || p;
}

export function hostDirname(kind: HostKind, p: string): string {
  if (isPosixHost(kind)) {
    return path.posix.dirname(p);
  }
  return path.dirname(p);
}

export function hostNormalize(kind: HostKind, p: string): string {
  if (isPosixHost(kind)) {
    // Keep absolute POSIX paths absolute; do not let Windows path.resolve rewrite them.
    const normalized = path.posix.normalize(p.replace(/\\/g, "/"));
    if (normalized === "." || normalized === "") return "/";
    return normalized;
  }
  return path.resolve(p);
}

export function hostIsAbsolute(kind: HostKind, p: string): boolean {
  if (isPosixHost(kind)) {
    return p.startsWith("/");
  }
  return path.isAbsolute(p);
}
