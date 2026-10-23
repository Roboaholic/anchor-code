import { FuzzyPathIndex, type FuzzyMatch } from "@/core/workspace/fuzzy";

export type FuzzySearchRequest = { id: number; paths?: string[]; query: string; limit: number };
export type FuzzySearchResponse = { id: number; matches?: FuzzyMatch[]; error?: boolean };

const WORKER_THRESHOLD = 5_000;
type PendingSearch = {
  id: number;
  query: string;
  limit: number;
  resolve: (matches: FuzzyMatch[]) => void;
};

/** One worker/index per palette; older searches never overwrite newer input. */
export class FuzzySearchClient {
  private worker: Worker | null = null;
  private workerFailed = false;
  private paths: string[] | null = null;
  private fallback: FuzzyPathIndex | null = null;
  private workerPaths: string[] | null = null;
  private pending: PendingSearch | null = null;
  private generation = 0;
  private disposed = false;

  constructor(private readonly createWorker = () => new Worker(new URL("./fuzzySearch.worker.ts", import.meta.url), { type: "module" })) {}

  search(paths: string[], query: string, limit = 80): Promise<FuzzyMatch[]> {
    if (this.disposed) return Promise.resolve([]);
    this.pending?.resolve([]);
    const id = ++this.generation;
    if (paths !== this.paths) {
      this.paths = paths;
      this.fallback = null;
    }
    return new Promise((resolve) => {
      this.pending = { id, query, limit, resolve };
      if (paths.length >= WORKER_THRESHOLD && query.trim() && !this.workerFailed) {
        try {
          if (!this.worker) {
            this.worker = this.createWorker();
            this.worker.onmessage = (event: MessageEvent<FuzzySearchResponse>) => {
              if (event.data.id !== this.pending?.id) return;
              if (event.data.error || !Array.isArray(event.data.matches)) this.failWorker();
              else this.finish(event.data.id, event.data.matches);
            };
            this.worker.onerror = (event) => { event.preventDefault(); this.failWorker(); };
            this.worker.onmessageerror = () => this.failWorker();
          }
          this.worker.postMessage({ id, query, limit, ...(this.workerPaths === paths ? {} : { paths }) } satisfies FuzzySearchRequest);
          this.workerPaths = paths;
          return;
        } catch {
          this.failWorker();
          return;
        }
      }
      this.runFallback(this.pending);
    });
  }

  private finish(id: number, matches: FuzzyMatch[]): void {
    if (this.pending?.id !== id) return;
    const pending = this.pending;
    this.pending = null;
    pending.resolve(matches);
  }

  private failWorker(): void {
    this.workerFailed = true;
    this.worker?.terminate();
    this.worker = null;
    this.workerPaths = null;
    if (this.pending) this.runFallback(this.pending);
  }

  private runFallback(request: PendingSearch): void {
    const index = this.fallback ??= new FuzzyPathIndex(this.paths ?? []);
    void index.rankAsync(request.query, request.limit, () => this.disposed || request.id !== this.generation)
      .then((matches) => this.finish(request.id, matches));
  }

  dispose(): void {
    this.disposed = true;
    ++this.generation;
    this.pending?.resolve([]);
    this.pending = null;
    this.worker?.terminate();
    this.worker = null;
    this.paths = null;
    this.workerPaths = null;
    this.fallback = null;
  }
}
