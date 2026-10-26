import type { WebContents } from "electron";

export type NavigationDecision =
  /** Same app document (reload / hash change): let it through. */
  | { action: "allow" }
  /** Leave the app alone and hand the URL to the OS browser / mail client. */
  | { action: "external"; url: string }
  /** Swallow it: the main window must never navigate away from the app. */
  | { action: "deny" };

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function documentKey(url: URL): string {
  // Hash-only changes stay on the same document.
  return `${url.protocol}//${url.host}${url.pathname}`;
}

/**
 * Decide what to do when the main window is asked to navigate to `target`.
 * `appUrl` is the URL the window was loaded with (file://…/index.html or the
 * Vite dev server). Anything other than the app document itself is blocked;
 * web/mail links open externally. A relative Markdown link such as
 * `diagrams/x.svg` resolves against file://…/dist/ and used to replace the
 * whole UI with a blank page.
 */
export function decideNavigation(target: string, appUrl: string | null): NavigationDecision {
  const next = parse(target);
  if (!next) return { action: "deny" };
  const app = appUrl ? parse(appUrl) : null;
  if (app && documentKey(next) === documentKey(app)) return { action: "allow" };
  if (EXTERNAL_PROTOCOLS.has(next.protocol)) {
    // The dev server is http too; anything else on its origin is still app-internal.
    if (app && (app.protocol === "http:" || app.protocol === "https:") && next.origin === app.origin) {
      return { action: "deny" };
    }
    return { action: "external", url: next.toString() };
  }
  return { action: "deny" };
}

/** `window.open` / target=_blank: never create a second app window. */
export function decideWindowOpen(target: string, appUrl: string | null): NavigationDecision {
  const decision = decideNavigation(target, appUrl);
  return decision.action === "allow" ? { action: "deny" } : decision;
}

/** Keep the main window on the app document; route web links to the OS. */
export function installNavigationGuard(
  contents: WebContents,
  appUrl: () => string | null,
  openExternal: (url: string) => void,
): void {
  const handle = (event: { preventDefault(): void }, url: string) => {
    const decision = decideNavigation(url, appUrl());
    if (decision.action === "allow") return;
    event.preventDefault();
    if (decision.action === "external") openExternal(decision.url);
    else console.warn("[main] blocked navigation away from the app:", url);
  };
  contents.on("will-navigate", handle);
  contents.on("will-redirect", handle);
  contents.setWindowOpenHandler(({ url }) => {
    const decision = decideWindowOpen(url, appUrl());
    if (decision.action === "external") openExternal(decision.url);
    return { action: "deny" };
  });
}
