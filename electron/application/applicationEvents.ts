import type { TerminalServiceEvent } from "../services/terminalService.js";

export type WorkspaceChangeSource = "desktop" | "remote";

export type AnchorApplicationEvent =
  | { type: "terminal"; event: TerminalServiceEvent }
  | {
      type: "workspace";
      source: WorkspaceChangeSource;
      workspace: {
        path: string;
        name: string;
        hostProfileId: string;
        hostKind: string;
      };
    };

export class ApplicationEvents {
  private readonly listeners = new Set<(event: AnchorApplicationEvent) => void>();

  subscribe(listener: (event: AnchorApplicationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: AnchorApplicationEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Observers must never interrupt application use cases.
      }
    }
  }
}
