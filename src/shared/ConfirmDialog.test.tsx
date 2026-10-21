// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConfirmDialogHost, confirmDialog } from "./ConfirmDialog";

describe("ConfirmDialog", () => {
  it("resolves true on confirm and false on cancel / Escape", async () => {
    render(<ConfirmDialogHost />);

    let result: boolean | undefined;
    act(() => {
      void confirmDialog({
        title: "Delete file",
        message: "This cannot be undone.",
        confirmLabel: "Delete",
        danger: true,
      }).then((ok) => {
        result = ok;
      });
    });

    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText("This cannot be undone.")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    await waitFor(() => expect(result).toBe(false));

    result = undefined;
    act(() => {
      void confirmDialog({
        title: "Again",
        message: "Once more",
      }).then((ok) => {
        result = ok;
      });
    });
    await screen.findByRole("alertdialog");
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    await waitFor(() => expect(result).toBe(false));

    result = undefined;
    act(() => {
      void confirmDialog({
        title: "Save",
        message: "Save changes?",
        confirmLabel: "Save",
      }).then((ok) => {
        result = ok;
      });
    });
    await screen.findByRole("alertdialog");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    await waitFor(() => expect(result).toBe(true));
  });
});
