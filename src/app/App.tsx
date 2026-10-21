import { Shell } from "@/features/shell/Shell";
import { ConfirmDialogHost } from "@/shared/ConfirmDialog";

export function App() {
  return (
    <>
      <Shell />
      <ConfirmDialogHost />
    </>
  );
}
