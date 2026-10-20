// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsPanel } from "./SettingsPanel";
import { useThemeStore } from "./themeStore";

describe("SettingsPanel", () => {
  afterEach(() => {
    cleanup();
    act(() => useThemeStore.getState().setSettingsOpen(false));
  });

  it("does not expose mobile access / pairing in the desktop settings", () => {
    render(<SettingsPanel />);
    act(() => useThemeStore.getState().setSettingsOpen(true));
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    const items = Array.from(nav.querySelectorAll("button")).map((b) => b.textContent);
    expect(items).toEqual(["Appearance", "Agent skill", "Updates"]);
    expect(screen.queryByText(/mobile access/i)).toBeNull();
    expect(screen.queryByText(/pairing/i)).toBeNull();
  });
});
