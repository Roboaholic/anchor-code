import { Shell } from "@/features/shell/Shell";
import { ConfirmDialogHost } from "@/shared/ConfirmDialog";
import { ErrorBoundary } from "@/shared/ErrorBoundary";

export function App() {
  return (
    <>
      <ErrorBoundary label="Anchor Code hit a rendering error">
        <Shell />
      </ErrorBoundary>
      <ConfirmDialogHost />
    </>
  );
}
