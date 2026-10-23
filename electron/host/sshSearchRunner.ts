import type { ChildProcess } from "node:child_process";
import { scheduleSshCommand } from "./openSshScheduler.js";
import { HostError, type RunOptions, type RunResult } from "./types.js";
import { WslSearchHelperClient } from "./wslSearchTools.js";

interface SearchRunnerOptions {
  alias: string;
  /** Starts a strictly authenticated SSH session running the JSONL helper. */
  spawn: () => ChildProcess;
  fallback: (cwd: string, command: string, args: string[], opts: RunOptions) => Promise<RunResult>;
  connectionError: (stderr: string) => HostError;
  readyTimeoutMs?: number;
}

function waitForHelper<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new HostError("failed", "Search cancelled"));
  return new Promise((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener("abort", aborted);
      reject(new HostError("failed", "Search cancelled"));
    };
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", aborted); resolve(value); },
      (error) => { signal.removeEventListener("abort", aborted); reject(error); },
    );
    if (signal.aborted) aborted();
  });
}

/** One authenticated connection serves cancellable, read-only search commands. */
export class OpenSshSearchRunner {
  private helper: WslSearchHelperClient | null = null;
  private starting: Promise<WslSearchHelperClient | null> | null = null;
  private cancelStart: (() => void) | null = null;
  private startFailures = 0;
  private disabled = false;
  private disposed = false;
  private generation = 0;
  private readonly activeRequests = new Set<AbortController>();

  constructor(private readonly options: SearchRunnerOptions) {}

  private assertCurrent(generation: number): void {
    if (this.disposed || generation !== this.generation) {
      throw new HostError("disconnected", "SSH search session has been closed");
    }
  }

  private getHelper(): Promise<WslSearchHelperClient | null> {
    if (this.disposed) return Promise.reject(new HostError("disconnected", "SSH search session has been closed"));
    if (this.disabled) return Promise.resolve(null);
    if (this.helper?.alive) return Promise.resolve(this.helper);
    if (this.starting) return this.starting;
    const starting = this.startHelper().finally(() => {
      if (this.starting === starting) this.starting = null;
    });
    this.starting = starting;
    return starting;
  }

  private startHelper(): Promise<WslSearchHelperClient | null> {
    const generation = this.generation;
    return new Promise((resolve, reject) => {
      let finished = false;
      let client: WslSearchHelperClient | null = null;
      let release: (() => void) | undefined;
      const queued: { cancel?: () => void } = {};
      let exitCode: number | null = null;
      let stderr = "";
      const finish = (ready: boolean, error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        queued.cancel?.();
        release?.();
        this.cancelStart = null;
        if (!ready) {
          this.startFailures++;
          if (exitCode === 98 || exitCode === 127 || this.startFailures >= 3) this.disabled = true;
          client?.dispose();
        } else {
          this.startFailures = 0;
          this.helper = client;
        }
        if (error) reject(error);
        else resolve(ready ? client : null);
      };
      this.cancelStart = () => finish(false, new HostError("disconnected", "SSH search session has been closed"));
      // Includes waiting for the per-alias handshake budget.
      const timer = setTimeout(() => finish(false), this.options.readyTimeoutMs ?? 20_000);
      queued.cancel = scheduleSshCommand(this.options.alias, (releaseSlot) => {
        release = releaseSlot;
        if (finished) { releaseSlot(); return; }
        if (this.disposed || generation !== this.generation) {
          finish(false, new HostError("disconnected", "SSH search session has been closed"));
          return;
        }
        try {
          const child = this.options.spawn();
          child.on("exit", (code) => { exitCode = code; });
          child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-16_384); });
          // A remote missing python3/failed authentication can close stdin early.
          child.stdin?.on("error", () => client?.dispose());
          client = new WslSearchHelperClient(child);
          client.ready.then(() => {
            if (this.disposed || generation !== this.generation) {
              finish(false, new HostError("disconnected", "SSH search session has been closed"));
            } else {
              finish(true);
            }
          }, () => finish(false, exitCode === 255 ? this.options.connectionError(stderr) : undefined));
        } catch {
          finish(false);
        }
      }, () => finish(false));
    });
  }

  async run(cwd: string, command: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
    const generation = this.generation;
    this.assertCurrent(generation);
    if (opts.signal?.aborted) return { stdout: "", stderr: "", code: 0, aborted: true };
    const controller = new AbortController();
    this.activeRequests.add(controller);
    const abort = () => controller.abort();
    opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) controller.abort();
    const timeoutMs = opts.timeoutMs ?? 45_000;
    let timedOut = false;
    let stdout = "";
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs) : undefined;
    const runOptions: RunOptions = {
      ...opts,
      signal: controller.signal,
      // The outer timer includes startup, queue time and any safe fallback.
      timeoutMs: 0,
      onStdoutChunk: (chunk, cumulative) => {
        if (controller.signal.aborted || this.disposed || generation !== this.generation) return;
        stdout += chunk;
        opts.onStdoutChunk?.(chunk, cumulative);
      },
    };
    try {
      const helper = await waitForHelper(this.getHelper(), controller.signal);
      this.assertCurrent(generation);
      let result: RunResult | undefined;
      if (helper) {
        try {
          result = await helper.run(cwd, command, args, runOptions);
        } catch (error) {
          this.assertCurrent(generation);
          // Never replay partial output: observers may already have displayed it.
          if (stdout || controller.signal.aborted || (error instanceof HostError && error.code === "timeout")) throw error;
          helper.dispose();
          if (this.helper === helper) this.helper = null;
        }
      }
      if (!result) {
        this.assertCurrent(generation);
        if (controller.signal.aborted) throw new HostError("failed", "Search cancelled");
        result = await waitForHelper(this.options.fallback(cwd, command, args, runOptions), controller.signal);
      }
      this.assertCurrent(generation);
      if (timedOut) throw new HostError("timeout", `SSH search timed out after ${timeoutMs}ms: ${command}`);
      return result;
    } catch (error) {
      this.assertCurrent(generation);
      if (timedOut) throw new HostError("timeout", `SSH search timed out after ${timeoutMs}ms: ${command}`);
      if (controller.signal.aborted) return { stdout, stderr: "", code: 0, aborted: true };
      throw error;
    } finally {
      clearTimeout(timer);
      this.activeRequests.delete(controller);
      opts.signal?.removeEventListener("abort", abort);
    }
  }

  /** Closing the last workspace may release the connection without closing the host. */
  disposeHelper(): void {
    this.generation++;
    for (const controller of this.activeRequests) controller.abort();
    this.cancelStart?.();
    this.helper?.dispose();
    this.helper = null;
    this.starting = null;
  }

  dispose(): void {
    this.disposed = true;
    this.disposeHelper();
  }
}
