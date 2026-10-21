// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Switch } from "./Switch";

function Harness() {
  const [on, setOn] = useState(false);
  return <Switch checked={on} onChange={setOn} aria-label="Demo" />;
}

describe("Switch", () => {
  it("toggles with click and keyboard", () => {
    render(<Harness />);
    const sw = screen.getByRole("switch", { name: "Demo" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(sw, { key: " " });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.keyDown(sw, { key: "Enter" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });
});
