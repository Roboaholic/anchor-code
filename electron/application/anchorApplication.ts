import type { HostManager } from "../host/hostManager.js";
import type { TerminalService } from "../services/terminalService.js";
import { AgentFacade } from "./agentFacade.js";
import { CommentFacade } from "./commentFacade.js";
import { ReviewFacade } from "./reviewFacade.js";
import { TerminalFacade } from "./terminalFacade.js";
import { WorkspaceFacade, type WorkspaceRegistry } from "./workspaceFacade.js";
import {
  ApplicationEvents,
  type AnchorApplicationEvent,
} from "./applicationEvents.js";

export interface AnchorApplicationOptions {
  hosts: HostManager;
  terminal: TerminalService;
  workspaceRegistry?: WorkspaceRegistry;
}

export class AnchorApplication {
  readonly workspace: WorkspaceFacade;
  readonly agent: AgentFacade;
  readonly review: ReviewFacade;
  readonly comments: CommentFacade;
  readonly terminal: TerminalFacade;
  private readonly events = new ApplicationEvents();

  constructor(options: AnchorApplicationOptions) {
    this.workspace = new WorkspaceFacade(
      options.hosts,
      options.terminal,
      (workspace, source) => this.events.publish({ type: "workspace", workspace, source }),
      options.workspaceRegistry,
    );
    this.agent = new AgentFacade(options.hosts, options.terminal, this.workspace);
    this.review = new ReviewFacade(options.hosts, this.workspace);
    this.comments = new CommentFacade(options.hosts, this.workspace);
    this.terminal = new TerminalFacade(options.terminal, this.workspace);
    options.terminal.subscribe((event) => {
      this.events.publish({ type: "terminal", event });
    });
  }

  subscribe(listener: (event: AnchorApplicationEvent) => void): () => void {
    return this.events.subscribe(listener);
  }
}
