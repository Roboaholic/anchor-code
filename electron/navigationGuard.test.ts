import { describe, expect, it, vi } from "vitest";
import { decideNavigation, decideWindowOpen, installNavigationGuard } from "./navigationGuard.js";

const APP = "file:///C:/Program%20Files/Anchor%20Code/resources/app.asar/dist/index.html";

describe("main window navigation guard", () => {
  it("blocks the relative Markdown link that used to blank the window", () => {
    // <a href="diagrams/x.svg"> resolves against the app's own file:// URL.
    const target = new URL("diagrams/detail-partial-stream.svg", APP).toString();
    expect(decideNavigation(target, APP)).toEqual({ action: "deny" });
    expect(decideNavigation("file:///etc/passwd", APP)).toEqual({ action: "deny" });
    expect(decideNavigation("javascript:alert(1)", APP)).toEqual({ action: "deny" });
    expect(decideNavigation("not a url", APP)).toEqual({ action: "deny" });
  });

  it("allows the app document itself (reload, hash change)", () => {
    expect(decideNavigation(APP, APP)).toEqual({ action: "allow" });
    expect(decideNavigation(`${APP}#section`, APP)).toEqual({ action: "allow" });
  });

  it("routes web and mail links to the OS", () => {
    expect(decideNavigation("https://github.com/x", APP)).toEqual({ action: "external", url: "https://github.com/x" });
    expect(decideNavigation("mailto:a@b.c", APP)).toMatchObject({ action: "external" });
  });

  it("keeps the Vite dev server origin internal", () => {
    const dev = "http://localhost:5173/";
    expect(decideNavigation("http://localhost:5173/", dev)).toEqual({ action: "allow" });
    expect(decideNavigation("http://localhost:5173/diagrams/x.svg", dev)).toEqual({ action: "deny" });
    expect(decideNavigation("https://example.com/", dev)).toMatchObject({ action: "external" });
  });

  it("never opens a second app window", () => {
    expect(decideWindowOpen(APP, APP)).toEqual({ action: "deny" });
    expect(decideWindowOpen("https://example.com/", APP)).toMatchObject({ action: "external" });
    expect(decideWindowOpen(new URL("a.svg", APP).toString(), APP)).toEqual({ action: "deny" });
  });

  it("wires will-navigate, will-redirect and window.open on the web contents", () => {
    const handlers = new Map<string, (event: { preventDefault(): void }, url: string) => void>();
    let openHandler!: (details: { url: string }) => { action: string };
    const contents = {
      on: vi.fn((name: string, handler: (event: { preventDefault(): void }, url: string) => void) => {
        handlers.set(name, handler);
      }),
      setWindowOpenHandler: vi.fn((handler: typeof openHandler) => { openHandler = handler; }),
    };
    const openExternal = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    installNavigationGuard(contents as never, () => APP, openExternal);

    const blocked = { preventDefault: vi.fn() };
    handlers.get("will-navigate")!(blocked, new URL("diagrams/x.svg", APP).toString());
    expect(blocked.preventDefault).toHaveBeenCalledOnce();
    expect(openExternal).not.toHaveBeenCalled();

    const web = { preventDefault: vi.fn() };
    handlers.get("will-redirect")!(web, "https://example.com/");
    expect(web.preventDefault).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledWith("https://example.com/");

    const reload = { preventDefault: vi.fn() };
    handlers.get("will-navigate")!(reload, APP);
    expect(reload.preventDefault).not.toHaveBeenCalled();

    expect(openHandler({ url: "https://example.org/" })).toEqual({ action: "deny" });
    expect(openExternal).toHaveBeenLastCalledWith("https://example.org/");
    expect(openHandler({ url: APP })).toEqual({ action: "deny" });
    warn.mockRestore();
  });
});
