/**
 * Multi-repo snapshots: capture HEAD + full worktree state (incl. untracked,
 * non-ignored files) of every repo in a workspace without touching the user's
 * index or worktree. See docs/design/multi-repo-snapshots.md.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseNameStatus } from "../../src/core/history/diffParse.js";
import {
  EMPTY_TREE,
  LARGE_FILE_BYTES,
  SNAPSHOT_REF_PREFIX,
  defaultSnapshotName,
  diffLargeFiles,
  newSnapshotId,
  overlapWarning,
  pushExposesAnchorRefs,
  retentionVictims,
  type SnapshotDiffPayload,
  type SnapshotDiffRepo,
  type SnapshotLargeFile,
  type SnapshotProgress,
  type SnapshotMeta,
  type SnapshotRepoEntry,
  type SnapshotSource,
  type SnapshotTurn,
} from "../../src/core/snapshots/model.js";
import { hostBasename, hostJoin, hostNormalize } from "../host/paths.js";
import type { HostSession, RunOptions } from "../host/types.js";
import { HostError } from "../host/types.js";

const GIT_IDENT: Record<string, string> = {
  GIT_AUTHOR_NAME: "anchor",
  GIT_AUTHOR_EMAIL: "anchor@localhost",
  GIT_COMMITTER_NAME: "anchor",
  GIT_COMMITTER_EMAIL: "anchor@localhost",
};

/** Persists the per-workspace snapshot index (fast list; git refs are the source of truth). */
export interface SnapshotIndexStore {
  /** `null` = index missing or unreadable (caller may rebuild it from refs). */
  load(workspaceKey: string): Promise<SnapshotMeta[] | null>;
  save(workspaceKey: string, list: SnapshotMeta[]): Promise<void>;
}

export function createFileIndexStore(dir: string): SnapshotIndexStore {
  const file = (key: string) =>
    path.join(dir, `${createHash("sha1").update(key).digest("hex").slice(0, 16)}.json`);
  return {
    async load(key) {
      try {
        const parsed = JSON.parse(await fs.readFile(file(key), "utf8")) as {
          snapshots?: SnapshotMeta[];
        };
        return Array.isArray(parsed.snapshots) ? parsed.snapshots : null;
      } catch {
        return null;
      }
    },
    async save(key, list) {
      await fs.mkdir(dir, { recursive: true });
      const target = file(key);
      const tmp = `${target}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ workspace: key, snapshots: list }));
      await fs.rename(tmp, target);
    },
  };
}

export interface SnapshotServiceOptions {
  index: SnapshotIndexStore;
  /** Where external stores live for local hosts (app data dir). Remote hosts use ~/.anchor/snapshots. */
  localStoreBase: string;
  largeFileBytes?: number;
  /** Repos snapshotted concurrently inside the remote script. */
  remoteParallel?: number;
  now?: () => number;
}

export interface CreateSnapshotInput {
  workspaceRoot: string;
  repoRoots: string[];
  name?: string;
  source: SnapshotSource;
  agentTabId?: string;
  agentLabel?: string;
  turn?: SnapshotTurn;
  /** For end snapshots: mark `empty` when every repo tree equals this snapshot's. */
  pairWithId?: string;
}

interface RepoGitInfo {
  gitDir: string;
  objectsDir: string;
}

async function git(
  host: HostSession,
  cwd: string,
  args: string[],
  opts?: RunOptions,
): Promise<string> {
  const r = await host.run(cwd, "git", args, { timeoutMs: 60_000, ...opts });
  if (r.code !== 0) {
    throw new HostError("failed", `git ${args[0]} failed`, (r.stderr || r.stdout).trim());
  }
  return r.stdout;
}

const FRAME = "@@ANCHOR@@";

function sq(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/**
 * Remote snapshot worker, one invocation per repo (run by xargs -P).
 * Args: tmpdir idx root ref storeRelToHome msgPrefix; $ANCHOR_BIG = large-file bytes.
 * Writes $T/idx.res ("ok <commit>\n{json fields}" or "error\n<stderr>")
 * and prints one progress line as soon as the repo is done.
 */
const SNAPSHOT_WORKER = String.raw`
exec </dev/null
T=$1 idx=$2 root=$3 ref=$4 srel=$5 pre=$6
err="$T/$idx.err"; lst="$T/$idx.large"
jesc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\000-\037'; }
exposes() {
  git config --get-regexp '^remote\..*\.(mirror|push)$' 2>/dev/null | while read -r k v; do
    k=$(printf '%s' "$k" | tr 'A-Z' 'a-z'); [ -n "$v" ] || v=true
    case "$k" in
      *.mirror) case "$v" in [Tt][Rr][Uu][Ee]|[Yy][Ee][Ss]|[Oo][Nn]|1) echo 1; return;; esac;;
      *.push) src=$\{v#+}; src=$\{src%%:*}
        [ -n "$src" ] || continue
        case "refs/anchor/snapshots/x" in $src) echo 1; return;; esac
        case "$src" in refs/anchor/*) echo 1; return;; esac;;
    esac
  done
}
work() {
  cd "$root" || return 1
  gd=$(git rev-parse --absolute-git-dir) || return 1
  cdir=$(git rev-parse --git-common-dir) || return 1
  od=$(cd "$cdir" && pwd)/objects
  head=$(git rev-parse -q --verify HEAD 2>/dev/null) || head=
  branch=$(git symbolic-ref --short -q HEAD 2>/dev/null) || branch=
  scratch=$gd store=
  if [ -n "$(exposes)" ]; then
    store="$HOME/$srel"
    [ -f "$store/HEAD" ] || { mkdir -p "$store" && git init --bare -q "$store"; } || return 1
    mkdir -p "$store/objects/info" && printf '%s\n' "$od" > "$store/objects/info/alternates" || return 1
    export GIT_OBJECT_DIRECTORY="$store/objects" GIT_ALTERNATE_OBJECT_DIRECTORIES="$od"
    scratch=$store
  fi
  git ls-files --others --exclude-standard -z | if command -v perl >/dev/null 2>&1; then
    perl -0ne 'chomp; my @s = lstat($_) or next; print "$s[7]|$s[9]|$_\0" if -f _ && $s[7] > $ENV{ANCHOR_BIG}'
  else xargs -0 sh -c '
    for f do [ -f "$f" ] && [ ! -L "$f" ] || continue
      sz=$(wc -c <"$f" 2>/dev/null) || continue
      if [ "$sz" -gt "$ANCHOR_BIG" ] 2>/dev/null; then
        mt=$(stat -c %Y -- "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0)
        printf "%s|%s|%s\0" "$sz" "$mt" "$f"
      fi
    done' sh; fi > "$lst" || return 1
  cache="$scratch/anchor-snapshot.index"; ix="$scratch/anchor-snapshot.$$.index"
  if [ -f "$cache" ]; then cp "$cache" "$ix"; elif [ -f "$gd/index" ]; then cp "$gd/index" "$ix"; fi
  { printf '.\0'; tr '\0' '\n' < "$lst" | while IFS='|' read -r a b p; do [ -n "$p" ] && printf ':(exclude,literal)%s\0' "$p"; done; } > "$lst.ps"
  GIT_INDEX_FILE="$ix" git -c core.autocrlf=false add -A --pathspec-from-file="$lst.ps" --pathspec-file-nul || { rm -f "$ix"; return 1; }
  tr '\0' '\n' < "$lst" | while IFS='|' read -r a b p; do [ -n "$p" ] && printf '%s\0' "$p"; done |
    GIT_INDEX_FILE="$ix" git update-index -z --force-remove --stdin || { rm -f "$ix"; return 1; }
  t=$(GIT_INDEX_FILE="$ix" git write-tree) || { rm -f "$ix"; return 1; }
  mv -f "$ix" "$cache"
  lf=; n=0
  tr '\0' '\n' < "$lst" > "$lst.nl"
  while IFS='|' read -r sz mt p; do
    [ -n "$p" ] || continue
    [ $n -gt 0 ] && lf="$lf,"; n=$((n + 1))
    lf="$lf{\"path\":\"$(jesc "$p")\",\"size\":$sz,\"mtimeMs\":$\{mt}000}"
  done < "$lst.nl"
  if [ -n "$head" ]; then hj="\"$head\""; else hj=null; fi
  if [ -n "$branch" ]; then bj="\"$(jesc "$branch")\""; else bj=null; fi
  if [ -n "$store" ]; then sj="\"storage\":\"external\",\"storeDir\":\"$(jesc "$store")\""; else sj="\"storage\":\"repo\""; fi
  fields="\"head\":$hj,\"branch\":$bj,\"tree\":\"$t\",$sj,\"largeFiles\":[$lf],\"status\":\"ok\""
  if [ -n "$head" ]; then
    c=$(printf '%s%s}}\n' "$pre" "$fields" | git commit-tree "$t" -p "$head") || return 1
  else
    c=$(printf '%s%s}}\n' "$pre" "$fields" | git commit-tree "$t") || return 1
  fi
  if [ -n "$store" ]; then
    (unset GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES; git --git-dir="$store" update-ref "$ref" "$c") || return 1
  else git update-ref "$ref" "$c" || return 1; fi
  printf 'ok %s\n{%s}\n' "$c" "$fields" > "$T/$idx.res"
  echo "$n" > "$T/$idx.n"
}
export LC_ALL=C
if (work) 2>"$err"; then
  printf '@@ANCHOR@@ P %s ok %s\n' "$idx" "$(cat "$T/$idx.n" 2>/dev/null || echo 0)"
else
  { echo error; tail -c 2000 "$err"; } > "$T/$idx.res"
  printf '@@ANCHOR@@ P %s error 0\n' "$idx"
fi
`.replace(/\$\\\{/g, "${");

export interface RemoteJob {
  root: string;
  ref: string;
  /** External store path relative to $HOME (used only if a remote pushes refs/*). */
  storeRel: string;
  /** Commit message up to and including `"repo":{"root":…,"name":…,`. */
  msgPrefix: string;
}

/** One `sh -s` script that snapshots every repo with bounded parallelism. */
export function buildRemoteScript(jobs: RemoteJob[], largeBytes: number, parallel: number): string {
  const args = jobs
    .map((j, i) => [String(i), j.root, j.ref, j.storeRel, j.msgPrefix].map(sq).join(" "))
    .join(" \\\n  ");
  return [
    "T=$(mktemp -d 2>/dev/null || mktemp -d -t anchorsnap) || exit 90",
    "trap 'rm -rf \"$T\"' EXIT",
    "cat > \"$T/w.sh\" <<'ANCHOR_WORKER_EOF'",
    SNAPSHOT_WORKER.trim(),
    "ANCHOR_WORKER_EOF",
    `printf '%s\\0' ${args} > "$T/args"`,
    `export ANCHOR_BIG=${largeBytes}`,
    `xargs -0 -n 5 -P ${parallel} sh "$T/w.sh" "$T" < "$T/args"`,
    `i=0; while [ $i -lt ${jobs.length} ]; do printf '\\n${FRAME} R %s\\n' $i; cat "$T/$i.res" 2>/dev/null || echo error; i=$((i + 1)); done`,
    "",
  ].join("\n");
}

export interface RemoteResult {
  idx: number;
  ok: boolean;
  commit?: string;
  fields?: Record<string, unknown>;
  error?: string;
}

export function parseProgressLines(chunk: string): { idx: number; ok: boolean; large: number }[] {
  const out: { idx: number; ok: boolean; large: number }[] = [];
  for (const m of chunk.matchAll(/^@@ANCHOR@@ P (\d+) (ok|error) (\d+)$/gm)) {
    out.push({ idx: Number(m[1]), ok: m[2] === "ok", large: Number(m[3]) });
  }
  return out;
}

export function parseRemoteResults(stdout: string): Map<number, RemoteResult> {
  const out = new Map<number, RemoteResult>();
  const parts = stdout.split(/\n@@ANCHOR@@ R (\d+)\n/);
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const idx = Number(parts[i]);
    const body = parts[i + 1]!;
    const nl = body.indexOf("\n");
    const first = nl < 0 ? body : body.slice(0, nl);
    const rest = nl < 0 ? "" : body.slice(nl + 1);
    if (first.startsWith("ok ")) {
      try {
        const jsonLine = rest.split("\n")[0] ?? "";
        out.set(idx, { idx, ok: true, commit: first.slice(3).trim(), fields: JSON.parse(jsonLine) as Record<string, unknown> });
      } catch {
        out.set(idx, { idx, ok: false, error: "unreadable snapshot result" });
      }
    } else {
      out.set(idx, { idx, ok: false, error: rest.replace(/\n@@ANCHOR@@ P[^\n]*/g, "").trim() });
    }
  }
  return out;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export class SnapshotService {
  private readonly largeBytes: number;
  private readonly remoteParallel: number;
  private readonly now: () => number;
  private readonly homeCache = new Map<string, Promise<string>>();
  /** Serialize index read-modify-write per workspace. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly opts: SnapshotServiceOptions) {
    this.largeBytes = opts.largeFileBytes ?? LARGE_FILE_BYTES;
    this.remoteParallel = opts.remoteParallel ?? 6;
    this.now = opts.now ?? Date.now;
  }

  private key(host: HostSession, workspaceRoot: string): string {
    return `${host.id}\0${hostNormalize(host.kind, workspaceRoot)}`;
  }

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.chains.set(key, run.catch(() => undefined));
    return run;
  }

  async list(host: HostSession, workspaceRoot: string, repoRoots?: string[]): Promise<SnapshotMeta[]> {
    const key = this.key(host, workspaceRoot);
    const list = await this.serial(key, () => this.loadIndex(host, workspaceRoot, repoRoots));
    return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Load the index; when missing/corrupt and repo roots are known, rebuild it from snapshot refs. Call inside `serial`. */
  private async loadIndex(host: HostSession, workspaceRoot: string, repoRoots?: string[]): Promise<SnapshotMeta[]> {
    const key = this.key(host, workspaceRoot);
    const list = await this.opts.index.load(key);
    if (list) return list;
    if (!repoRoots) return [];
    const rebuilt = await this.rebuildIndex(host, workspaceRoot, repoRoots);
    await this.opts.index.save(key, rebuilt);
    return rebuilt;
  }

  /**
   * Reconstruct snapshot metadata from `refs/anchor/snapshots/*` in each repo and in its
   * external store. Each snapshot commit message carries the meta + that repo's entry as JSON.
   * Names revert to the name at creation time (renames live only in the index).
   */
  async rebuildIndex(host: HostSession, workspaceRoot: string, repoRoots: string[]): Promise<SnapshotMeta[]> {
    const wsNorm = hostNormalize(host.kind, workspaceRoot);
    const byId = new Map<string, SnapshotMeta>();
    const perRepo = await mapLimit(repoRoots, 6, async (root) => {
      const found: Array<{ meta: SnapshotMeta; entry: SnapshotRepoEntry }> = [];
      const dirs: string[] = [root];
      const storeDir = await this.storeDirFor(host, root);
      if (await host.exists(hostJoin(host.kind, storeDir, "HEAD")).catch(() => false)) dirs.push(storeDir);
      for (const dir of dirs) {
        const refs = await host.run(dir, "git", ["for-each-ref", "--format=%(objectname)", SNAPSHOT_REF_PREFIX], { timeoutMs: 30_000 });
        if (refs.code !== 0) continue;
        for (const commit of refs.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
          const body = await host.run(dir, "git", ["cat-file", "commit", commit], { timeoutMs: 20_000 });
          if (body.code !== 0) continue;
          const msg = body.stdout.slice(body.stdout.indexOf("\n\n") + 2);
          const jsonStart = msg.indexOf("\n\n{");
          if (jsonStart < 0) continue;
          try {
            const parsed = JSON.parse(msg.slice(jsonStart + 2).trim()) as SnapshotMeta & { repo?: SnapshotRepoEntry };
            if (!parsed?.id || !parsed.repo || hostNormalize(host.kind, parsed.workspaceRoot ?? "") !== wsNorm) continue;
            const { repo, ...rest } = parsed;
            const entry: SnapshotRepoEntry = { ...repo, root, commit };
            if (dir !== root) Object.assign(entry, { storage: "external", storeDir: dir });
            found.push({ meta: { ...rest, repos: [] } as SnapshotMeta, entry });
          } catch {
            /* not a snapshot commit we understand */
          }
        }
      }
      return found;
    }).catch(() => []);
    for (const items of perRepo) {
      for (const { meta, entry } of items) {
        const cur = byId.get(meta.id) ?? { ...meta, repos: [] };
        cur.repos.push(entry);
        byId.set(meta.id, cur);
      }
    }
    return [...byId.values()];
  }

  private async storeDirFor(host: HostSession, root: string): Promise<string> {
    const baseDir =
      host.kind === "local"
        ? this.opts.localStoreBase
        : hostJoin(host.kind, await this.home(host), ".anchor", "snapshots");
    return hostJoin(host.kind, baseDir, `${this.storeHash(host, root)}.git`);
  }

  private storeHash(host: HostSession, root: string): string {
    return createHash("sha1").update(`${host.id}\0${hostNormalize(host.kind, root)}`).digest("hex").slice(0, 16);
  }

  async create(
    host: HostSession,
    input: CreateSnapshotInput,
    onProgress?: (p: SnapshotProgress) => void,
  ): Promise<SnapshotMeta> {
    const nowMs = this.now();
    const id = newSnapshotId(nowMs);
    const createdAt = new Date(nowMs).toISOString();
    const name = input.name?.trim().slice(0, 80) || defaultSnapshotName(new Date(nowMs));
    const base: Omit<SnapshotMeta, "repos"> = {
      v: 1,
      id,
      workspaceRoot: input.workspaceRoot,
      name,
      source: input.source,
      ...(input.agentTabId ? { agentTabId: input.agentTabId } : {}),
      ...(input.agentLabel ? { agentLabel: input.agentLabel } : {}),
      ...(input.turn ? { turn: input.turn } : {}),
      createdAt,
    };
    const progress: SnapshotProgress = {
      id,
      source: input.source,
      ...(input.agentTabId ? { agentTabId: input.agentTabId } : {}),
      total: input.repoRoots.length,
      done: 0,
      failed: 0,
      largeFiles: 0,
      repos: input.repoRoots.map((root) => ({ name: hostBasename(host.kind, root) || root, state: "pending" as const })),
    };
    const emit = () => onProgress?.(structuredClone(progress));
    const mark = (i: number, ok: boolean, large: number) => {
      const r = progress.repos[i];
      if (!r || r.state !== "pending") return;
      r.state = ok ? "ok" : "error";
      progress.done++;
      if (!ok) progress.failed++;
      progress.largeFiles += large;
      emit();
    };
    emit();
    const repos =
      host.kind !== "local" && input.repoRoots.length > 0
        ? await this.createRemote(host, input.repoRoots, base, mark)
        : await this.createLocal(host, input.repoRoots, base, mark);
    repos.forEach((r, i) => mark(i, r.status === "ok", r.largeFiles.length));
    const meta: SnapshotMeta = { ...base, repos };
    return this.finishCreate(host, input, meta, nowMs);
  }

  private createLocal(
    host: HostSession,
    roots: string[],
    base: Omit<SnapshotMeta, "repos">,
    mark: (i: number, ok: boolean, large: number) => void,
  ): Promise<SnapshotRepoEntry[]> {
    return mapLimit(roots, 6, (root) =>
      this.snapshotRepo(host, root, base).catch(
        (err): SnapshotRepoEntry => ({
          root,
          name: hostBasename(host.kind, root) || root,
          head: null,
          branch: null,
          commit: "",
          tree: "",
          storage: "repo",
          largeFiles: [],
          status: "error",
          note: err instanceof Error ? err.message + (err instanceof HostError && err.causeDetail ? `: ${err.causeDetail}` : "") : String(err),
        }),
      ).then((entry) => {
        mark(roots.indexOf(root), entry.status === "ok", entry.largeFiles.length);
        return entry;
      }),
    );
  }

  private finishCreate(host: HostSession, input: CreateSnapshotInput, meta: SnapshotMeta, nowMs: number): Promise<SnapshotMeta> {
    const key = this.key(host, input.workspaceRoot);
    return this.serial(key, async () => {
      const list = await this.loadIndex(host, input.workspaceRoot, input.repoRoots);
      if (input.pairWithId) {
        const pair = list.find((s) => s.id === input.pairWithId);
        if (pair && sameTrees(pair, meta)) meta.empty = true;
      }
      list.push(meta);
      const victims = new Set(retentionVictims(list, nowMs));
      const keep = list.filter((s) => !victims.has(s.id));
      await this.opts.index.save(key, keep);
      if (victims.size > 0) {
        void this.deleteRefs(host, list.filter((s) => victims.has(s.id))).catch(() => undefined);
      }
      return meta;
    });
  }

  async rename(host: HostSession, workspaceRoot: string, id: string, name: string, repoRoots?: string[]): Promise<void> {
    const key = this.key(host, workspaceRoot);
    const clean = name.trim().slice(0, 80);
    if (!clean) return;
    await this.serial(key, async () => {
      const list = await this.loadIndex(host, workspaceRoot, repoRoots);
      await this.opts.index.save(
        key,
        list.map((s) => (s.id === id ? { ...s, name: clean } : s)),
      );
    });
  }

  async remove(host: HostSession, workspaceRoot: string, ids: string[], repoRoots?: string[]): Promise<void> {
    const key = this.key(host, workspaceRoot);
    const drop = new Set(ids);
    const removed = await this.serial(key, async () => {
      const list = await this.loadIndex(host, workspaceRoot, repoRoots);
      await this.opts.index.save(key, list.filter((s) => !drop.has(s.id)));
      return list.filter((s) => drop.has(s.id));
    });
    await this.deleteRefs(host, removed);
  }

  /** Diff `baseId` against another snapshot or the current worktree. */
  async compare(
    host: HostSession,
    args: { workspaceRoot: string; repoRoots: string[]; baseId: string; targetId: string | "worktree" },
  ): Promise<SnapshotDiffPayload> {
    const list = await this.list(host, args.workspaceRoot, args.repoRoots);
    let base = list.find((s) => s.id === args.baseId);
    let target = args.targetId === "worktree" ? null : list.find((s) => s.id === args.targetId);
    if (!base || (args.targetId !== "worktree" && !target)) {
      throw new HostError("not_found", "Snapshot not found");
    }
    if (target && target.createdAt < base.createdAt) [base, target] = [target, base];
    const b = base;
    const roots = new Map<string, string>();
    for (const r of b.repos) roots.set(hostNormalize(host.kind, r.root), r.root);
    for (const r of target?.repos ?? []) roots.set(hostNormalize(host.kind, r.root), r.root);
    if (!target) for (const r of args.repoRoots) roots.set(hostNormalize(host.kind, r), r);
    const find = (s: SnapshotMeta | null | undefined, root: string) =>
      s?.repos.find((r) => hostNormalize(host.kind, r.root) === root && r.status === "ok");

    const repos = await mapLimit([...roots.entries()], 6, async ([key, root]) =>
      this.compareRepo(host, root, find(b, key), target ? find(target, key) ?? null : "worktree").catch(
        (err): SnapshotDiffRepo => ({
          root,
          name: hostBasename(host.kind, root) || root,
          state: "error",
          base: "",
          head: "worktree",
          files: [],
          largeFiles: [],
          error: err instanceof Error ? err.message : String(err),
        }),
      ),
    );
    const order = { changed: 0, added: 1, removed: 2, error: 3, unchanged: 4 } as const;
    repos.sort((x, y) => order[x.state] - order[y.state] || x.name.localeCompare(y.name));
    const warn = overlapWarning(list, b.id, target ? target.id : "worktree", this.now());
    return {
      workspaceRoot: args.workspaceRoot,
      baseId: b.id,
      targetId: target ? target.id : "worktree",
      title: `${b.name} → ${target ? target.name : "当前"}`,
      repos,
      ...(warn ? { overlapWarning: warn } : {}),
    };
  }

  /** External-store objects dir for a revision, so readers can add it as an alternate. */
  async alternatesFor(host: HostSession, workspaceRoot: string, repoRoot: string, revs: string[]): Promise<string | null> {
    const list = (await this.opts.index.load(this.key(host, workspaceRoot))) ?? [];
    const key = hostNormalize(host.kind, repoRoot);
    for (const s of list) {
      for (const r of s.repos) {
        if (r.storage === "external" && r.storeDir && hostNormalize(host.kind, r.root) === key && revs.includes(r.commit)) {
          return hostJoin(host.kind, r.storeDir, "objects");
        }
      }
    }
    return null;
  }

  // ── per repo ─────────────────────────────────────────

  private async repoGit(host: HostSession, root: string): Promise<RepoGitInfo> {
    const out = await git(host, root, ["rev-parse", "--absolute-git-dir", "--git-common-dir"]);
    const [gitDir = "", common = ""] = out.split("\n").map((l) => l.trim());
    const commonAbs = common.startsWith("/") || /^[A-Za-z]:/.test(common) ? common : hostJoin(host.kind, root, common);
    return { gitDir, objectsDir: hostJoin(host.kind, commonAbs, "objects") };
  }

  private async home(host: HostSession): Promise<string> {
    let p = this.homeCache.get(host.id);
    if (!p) {
      p = host.run("/", "printenv", ["HOME"], { timeoutMs: 10_000 }).then((r) => r.stdout.trim());
      this.homeCache.set(host.id, p);
    }
    return p;
  }

  /** Bare repo outside the user's repo for remotes that mirror / push refs/*. */
  private async externalStore(host: HostSession, root: string, info: RepoGitInfo): Promise<string> {
    const dir = await this.storeDirFor(host, root);
    if (!(await host.exists(hostJoin(host.kind, dir, "HEAD")))) {
      await host.mkdirp(dir);
      await git(host, dir, ["init", "--bare", "-q", "."]);
    }
    // Let the store resolve the user repo's objects (HEAD tree, parent commits).
    await host.mkdirp(hostJoin(host.kind, dir, "objects", "info"));
    await host.writeFile(hostJoin(host.kind, dir, "objects", "info", "alternates"), `${info.objectsDir}\n`);
    return dir;
  }

  private async largeUntracked(host: HostSession, root: string): Promise<SnapshotLargeFile[]> {
    const out = await git(host, root, ["ls-files", "--others", "--exclude-standard", "-z"]);
    const paths = out.split("\0").filter(Boolean);
    const stats = await mapLimit(paths, 16, async (p) => {
      try {
        const st = await host.stat(hostJoin(host.kind, root, p));
        return st.isFile && st.size > this.largeBytes ? { path: p, size: st.size, mtimeMs: Math.round(st.mtimeMs) } : null;
      } catch {
        return null;
      }
    });
    return stats.filter((s): s is SnapshotLargeFile => s !== null);
  }

  /**
   * Write the worktree as a tree object via a throwaway index.
   * The user's index/worktree are never modified; hooks never run.
   */
  private async captureTree(
    host: HostSession,
    root: string,
    info: RepoGitInfo,
    largeFiles: SnapshotLargeFile[],
    store: string | null,
  ): Promise<string> {
    const scratchDir = store ?? info.gitDir;
    const idx = hostJoin(host.kind, scratchDir, `anchor-snapshot-${newSnapshotId(this.now())}.index`);
    const env: Record<string, string> = { GIT_INDEX_FILE: idx };
    if (store) {
      env.GIT_OBJECT_DIRECTORY = hostJoin(host.kind, store, "objects");
      env.GIT_ALTERNATE_OBJECT_DIRECTORIES = info.objectsDir;
    }
    try {
      const realIndex = hostJoin(host.kind, info.gitDir, "index");
      // Copy the real index so its stat cache avoids rehashing every file.
      if (await host.exists(realIndex)) await host.copyPath(realIndex, idx);
      const pathspec = [".", ...largeFiles.map((f) => `:(exclude,literal)${f.path}`)].join("\0") + "\0";
      await git(host, root, ["-c", "core.autocrlf=false", "add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], {
        env,
        stdin: pathspec,
        timeoutMs: 120_000,
      });
      return (await git(host, root, ["write-tree"], { env })).trim();
    } finally {
      await host.remove(idx).catch(() => undefined);
    }
  }

  /**
   * Remote hosts: every host.run is a fresh ssh handshake (OpenSSH allows 2 per
   * alias), so the whole snapshot runs as ONE script over ONE connection.
   * Repos run in parallel remotely; each prints a progress line when done and
   * failures are reported per repo.
   */
  private async createRemote(
    host: HostSession,
    roots: string[],
    meta: Omit<SnapshotMeta, "repos">,
    onRepo: (i: number, ok: boolean, large: number) => void,
  ): Promise<SnapshotRepoEntry[]> {
    const jobs: RemoteJob[] = roots.map((root) => {
      const name = hostBasename(host.kind, root) || root;
      const head = JSON.stringify({ ...meta, repo: { root, name } });
      return {
        root,
        ref: `${SNAPSHOT_REF_PREFIX}${meta.id}`,
        storeRel: `.anchor/snapshots/${this.storeHash(host, root)}.git`,
        msgPrefix: `anchor snapshot: ${meta.name}\n\n${head.slice(0, -2)},`,
      };
    });
    const failed = (root: string, note: string): SnapshotRepoEntry => ({
      root,
      name: hostBasename(host.kind, root) || root,
      head: null,
      branch: null,
      commit: "",
      tree: "",
      storage: "repo",
      largeFiles: [],
      status: "error",
      note,
    });
    let seen = "";
    const r = await host.run("/", "sh", ["-s"], {
      stdin: buildRemoteScript(jobs, this.largeBytes, this.remoteParallel),
      env: GIT_IDENT,
      timeoutMs: 600_000,
      onStdoutChunk: (_chunk, stdout) => {
        const lineEnd = stdout.lastIndexOf("\n");
        const fresh = stdout.slice(seen.length, lineEnd + 1);
        seen = stdout.slice(0, lineEnd + 1);
        for (const p of parseProgressLines(fresh)) {
          if (roots[p.idx] !== undefined) onRepo(p.idx, p.ok, p.large);
        }
      },
    });
    const results = parseRemoteResults(r.stdout);
    const whole = (r.stderr || `exit ${r.code}`).trim();
    return roots.map((root, i) => {
      const res = results.get(i);
      if (!res) return failed(root, `snapshot script failed: ${whole}`);
      if (!res.ok) return failed(root, res.error || "snapshot failed");
      const f = res.fields as Partial<SnapshotRepoEntry>;
      return {
        root,
        name: hostBasename(host.kind, root) || root,
        head: f.head ?? null,
        branch: f.branch ?? null,
        commit: res.commit!,
        tree: f.tree ?? "",
        storage: f.storage === "external" ? "external" : "repo",
        ...(f.storeDir ? { storeDir: f.storeDir } : {}),
        largeFiles: f.largeFiles ?? [],
        status: "ok",
      };
    });
  }

  private async snapshotRepo(
    host: HostSession,
    root: string,
    meta: Omit<SnapshotMeta, "repos">,
  ): Promise<SnapshotRepoEntry> {
    const info = await this.repoGit(host, root);
    const headR = await host.run(root, "git", ["rev-parse", "-q", "--verify", "HEAD"], { timeoutMs: 20_000 });
    const head = headR.code === 0 ? headR.stdout.trim() || null : null;
    const branchR = await host.run(root, "git", ["symbolic-ref", "--short", "-q", "HEAD"], { timeoutMs: 20_000 });
    const branch = branchR.code === 0 ? branchR.stdout.trim() || null : null;
    const cfg = await host.run(root, "git", ["config", "--get-regexp", "^remote\\..*\\.(mirror|push)$"], { timeoutMs: 20_000 });
    const external = pushExposesAnchorRefs(cfg.stdout);
    const store = external ? await this.externalStore(host, root, info) : null;
    const largeFiles = await this.largeUntracked(host, root);
    const tree = await this.captureTree(host, root, info, largeFiles, store);
    const entry: SnapshotRepoEntry = {
      root,
      name: hostBasename(host.kind, root) || root,
      head,
      branch,
      commit: "",
      tree,
      storage: external ? "external" : "repo",
      ...(store ? { storeDir: store } : {}),
      largeFiles,
      status: "ok",
    };
    const message = `anchor snapshot: ${meta.name}\n\n${JSON.stringify({ ...meta, repo: { ...entry, commit: undefined } })}\n`;
    const env: Record<string, string> = { ...GIT_IDENT };
    if (store) {
      env.GIT_OBJECT_DIRECTORY = hostJoin(host.kind, store, "objects");
      env.GIT_ALTERNATE_OBJECT_DIRECTORIES = info.objectsDir;
    }
    const commit = (
      await git(host, root, ["commit-tree", tree, ...(head ? ["-p", head] : [])], { env, stdin: message })
    ).trim();
    const ref = `${SNAPSHOT_REF_PREFIX}${meta.id}`;
    if (store) await git(host, store, ["update-ref", ref, commit]);
    else await git(host, root, ["update-ref", ref, commit]);
    return { ...entry, commit };
  }

  private async compareRepo(
    host: HostSession,
    root: string,
    base: SnapshotRepoEntry | undefined,
    target: SnapshotRepoEntry | null | "worktree",
  ): Promise<SnapshotDiffRepo> {
    const name = hostBasename(host.kind, root) || root;
    if (target === null) {
      return { root, name, state: "removed", base: base?.commit ?? "", head: "", files: [], largeFiles: [] };
    }
    let headRev: string | "worktree";
    let headTree: string;
    let headLarge: SnapshotLargeFile[];
    const alternates = [base?.storeDir, target !== "worktree" ? target.storeDir : undefined]
      .filter((d): d is string => !!d)
      .map((d) => hostJoin(host.kind, d, "objects"));
    if (target === "worktree") {
      const info = await this.repoGit(host, root);
      headLarge = await this.largeUntracked(host, root);
      // Scratch tree for the current worktree; never referenced, gc reclaims it.
      headTree = await this.captureTree(host, root, info, headLarge, base?.storeDir ?? null);
      headRev = "worktree";
    } else {
      headTree = target.tree;
      headLarge = target.largeFiles;
      headRev = target.commit;
    }
    const baseTree = base?.tree ?? EMPTY_TREE;
    const env = alternates.length ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates.join(host.kind === "local" && process.platform === "win32" ? ";" : ":") } : undefined;
    const out = baseTree === headTree ? "" : await git(host, root, ["diff", "--name-status", "-M", baseTree, headTree], { env });
    const files = parseNameStatus(out);
    const largeFiles = diffLargeFiles(base?.largeFiles ?? [], headLarge);
    const state = !base ? "added" : files.length || largeFiles.length ? "changed" : "unchanged";
    return { root, name, state, base: base?.commit ?? EMPTY_TREE, head: headRev, files, largeFiles };
  }

  private async deleteRefs(host: HostSession, snaps: SnapshotMeta[]): Promise<void> {
    const jobs = snaps.flatMap((s) =>
      s.repos
        .filter((r) => r.status === "ok")
        .map((r) => ({ cwd: r.storage === "external" && r.storeDir ? r.storeDir : r.root, ref: `${SNAPSHOT_REF_PREFIX}${s.id}` })),
    );
    await mapLimit(jobs, 6, (j) => host.run(j.cwd, "git", ["update-ref", "-d", j.ref], { timeoutMs: 20_000 }).catch(() => undefined));
  }
}

function sameTrees(a: SnapshotMeta, b: SnapshotMeta): boolean {
  const map = new Map(a.repos.map((r) => [r.root, r]));
  if (a.repos.length !== b.repos.length) return false;
  return b.repos.every((r) => {
    const o = map.get(r.root);
    return (
      !!o &&
      o.status === "ok" &&
      r.status === "ok" &&
      o.tree === r.tree &&
      diffLargeFiles(o.largeFiles, r.largeFiles).length === 0
    );
  });
}

/** File contents for a snapshot diff when one side lives in an external store. */
export async function snapshotFileDiffWithAlternates(
  host: HostSession,
  repoRoot: string,
  base: string,
  head: string | "worktree",
  filePath: string,
  status: string,
  alternates: string,
): Promise<{ path: string; oldText: string; newText: string; status: string }> {
  const env = { GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates };
  const show = async (rev: string) => {
    const r = await host.run(repoRoot, "git", ["show", `${rev}:${filePath}`], { env, timeoutMs: 30_000 });
    return r.code === 0 ? r.stdout : "";
  };
  const needOld = !status.startsWith("A") && status !== "?";
  const needNew = !status.startsWith("D");
  const [oldText, newText] = await Promise.all([
    needOld ? show(base) : Promise.resolve(""),
    !needNew
      ? Promise.resolve("")
      : head === "worktree"
        ? host.readFile(hostJoin(host.kind, repoRoot, filePath)).catch(() => "")
        : show(head),
  ]);
  return { path: filePath, oldText, newText, status };
}
