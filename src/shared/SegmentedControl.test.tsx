// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { SegmentedControl } from "./SegmentedControl";

function Harness() {
  const [value, setValue] = useState("a");
  return (
    <SegmentedControl
      aria-label="Pick"
      value={value}
      onChange={setValue}
      options={[
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ]}
    />
  );
}

describe("SegmentedControl", () => {
  it("selects a segment", () => {
    render(<Harness />);
    expect(screen.getByRole("radio", { name: "A" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "B" }));
    expect(screen.getByRole("radio", { name: "B" }).getAttribute("aria-checked")).toBe("true");
  });
});
