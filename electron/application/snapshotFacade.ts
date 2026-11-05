import type { HostManager } from "../host/hostManager.js";
import type {
  CreateSnapshotInput,
  SnapshotService,
} from "../services/snapshotService.js";
import type { SnapshotProgress } from "../../src/core/snapshots/model.js";
import type { ReviewFacade } from "./reviewFacade.js";
import type { WorkspaceFacade } from "./workspaceFacade.js";

type CreateArgs = Omit<CreateSnapshotInput, "workspaceRoot" | "repoRoots">;

/** Multi-repo snapshots for the active workspace (all repos discovered by History). */
export class SnapshotFacade {
  constructor(
    private readonly hosts: HostManager,
    private readonly workspace: WorkspaceFacade,
    private readonly review: ReviewFacade,
    private readonly service: SnapshotService,
  ) {
    review.setSnapshotAlternatesResolver((repoRoot, revs) =>
      this.service.alternatesFor(this.hosts.session, this.workspace.root(), repoRoot, revs),
    );
  }

  private async repoRoots(): Promise<string[]> {
    return (await this.review.repos(this.workspace.root())).map((r) => r.root);
  }

  async list() {
    return this.service.list(this.hosts.session, this.workspace.root(), await this.repoRoots());
  }

  async create(args: CreateArgs, onProgress?: (p: SnapshotProgress) => void) {
    return this.service.create(
      this.hosts.session,
      { ...args, workspaceRoot: this.workspace.root(), repoRoots: await this.repoRoots() },
      onProgress,
    );
  }

  async rename(id: string, name: string) {
    return this.service.rename(this.hosts.session, this.workspace.root(), id, name, await this.repoRoots());
  }

  async remove(ids: string[]) {
    return this.service.remove(this.hosts.session, this.workspace.root(), ids, await this.repoRoots());
  }

  async compare(baseId: string, targetId: string | "worktree") {
    return this.service.compare(this.hosts.session, {
      workspaceRoot: this.workspace.root(),
      repoRoots: await this.repoRoots(),
      baseId,
      targetId,
    });
  }
}
