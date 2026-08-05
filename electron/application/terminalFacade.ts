import { HostError } from "../host/types.js";
import type { TerminalCreateOptions, TerminalService } from "../services/terminalService.js";
import type { WorkspaceFacade } from "./workspaceFacade.js";

export class TerminalFacade {
  constructor(
    private readonly terminal: TerminalService,
    private readonly workspace: WorkspaceFacade,
  ) {}

  list() { return this.terminal.list(); }

  create(input: Omit<TerminalCreateOptions, "cwd"> & { cwd?: string } = {}) {
    return this.terminal.create({ ...input, cwd: input.cwd ?? this.workspace.root() });
  }

  snapshot(id: string) {
    const state = this.terminal.snapshotState(id);
    if (!state) throw new HostError("not_found", `Terminal not found: ${id}`);
    return { id, ...state };
  }

  rename(id: string, title: string) {
    const info = this.terminal.rename(id, title);
    if (!info) throw new HostError("not_found", `Terminal not found: ${id}`);
    return info;
  }
  applyAgentTitle(id: string, title: string) {
    const info = this.terminal.setAgentTitle(id, title);
    if (!info) throw new HostError("not_found", `Terminal not found: ${id}`);
    return info;
  }

  applyTitle(id: string, title: string) {
    const info = this.terminal.applyDynamicTitle(id, title);
    if (!info) throw new HostError("not_found", `Terminal not found: ${id}`);
    return info;
  }
  applyAgentTopic(id: string, line: string) {
    const info = this.terminal.applyAgentTopicFromInput(id, line);
    if (!info) throw new HostError("not_found", `Terminal not found: ${id}`);
    return info;
  }
  write(id: string, data: string) { this.terminal.write(id, data); }
  resize(id: string, cols: number, rows: number) { this.terminal.resize(id, cols, rows); }
  remove(id: string) { this.terminal.kill(id); }
  disposeAll() { this.terminal.disposeAll(); }
}
