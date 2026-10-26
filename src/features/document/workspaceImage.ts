import { useEffect, useState } from "react";
import { formatError } from "@/shared/formatError";
import { imageDataUrl } from "@/core/workspace/markdownLinks";

export type WorkspaceImageState =
  | { status: "loading" }
  | { status: "ready"; src: string; mime: string }
  | { status: "error"; error: string };

/**
 * Load a workspace image through the active host (Local / WSL / SSH) and hand
 * back a data URL for `<img>`. SVG arrives as image/svg+xml, so the browser
 * renders it as an image: embedded scripts and external loads never run.
 */
export async function loadWorkspaceImage(path: string): Promise<{ src: string; mime: string }> {
  const result = await window.anchor.workspace.readImage(path);
  return { src: imageDataUrl(result.mime, result.base64), mime: result.mime };
}

export function useWorkspaceImage(path: string | null, reloadKey: unknown = null): WorkspaceImageState {
  const [state, setState] = useState<WorkspaceImageState>({ status: "loading" });
  useEffect(() => {
    if (!path) {
      setState({ status: "error", error: "Missing image path" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    loadWorkspaceImage(path).then(
      (loaded) => {
        if (!cancelled) setState({ status: "ready", ...loaded });
      },
      (err: unknown) => {
        if (!cancelled) setState({ status: "error", error: formatError(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path, reloadKey]);
  return state;
}
