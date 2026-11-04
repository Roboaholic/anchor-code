# 多仓快照（Multi-repo Snapshots）设计

状态：设计稿（Phase 1，未实现）· 分支 `feat/multi-repo-snapshots`

## 1. 目标

- 一次「打点」给工作区里**所有** git 仓记下完整状态（HEAD + 已暂存 + 未暂存 + 未跟踪且未忽略的文件），不碰用户的 worktree / index。
- 三种来源进同一个列表：
  - `manual`：人在 HISTORY → 快照栏点「打点」；
  - `auto`：App 在每轮 agent prompt 开始 / 结束时自动打；
  - `agent`：agent 在终端里执行 `anchor snapshot "msg"` 主动打。
- 任意一个点 vs 当前工作区、任意两个点之间，打开**多仓 diff 工作台**：按仓分组，无变化的仓折叠，复用现有 `DiffViewer` 和行级评论。
- agent 侧栏的每个 agent 条目可跳到它各轮的自动快照。

非目标：区分「谁」改了哪一行（重叠时间只提示）；把快照推到远端；替代 git 提交。

## 2. 现有代码调研（扩展点）

| 区域 | 文件 | 说明 / 扩展点 |
|---|---|---|
| HISTORY 面板 | `src/features/history/HistoryPane.tsx`、`historyStore.ts` | 每仓一张卡（`repo-row`），内含 Commits / Compares 两个 `repo-block`。新增工作区级 `SnapshotsSection` 放在仓卡列表**下方**，复用 `repo-block` / `commit-row` / `recent-compare-row` 样式 |
| git 服务 | `electron/services/historyService.ts` | `discoverRepos`、`compareCommits`、`compareToWorktree`、`getFileDiff`、`readRun`（WSL 读快路径）、`gitFailure`。写操作必须走 `host.run`。新增 `electron/services/snapshotService.ts`，复用 `parseNameStatus` / `mergeDiffFiles` / `gitShow` |
| 主机抽象 | `electron/host/types.ts`（`HostSession`）、`localHost.ts`、`wslHost.ts`、`sshHost.ts` / `openSshHost.ts`、`openSshScheduler.ts` | 所有 git 命令经 `HostSession.run(cwd, cmd, args, opts)`，天然支持 Local/WSL/SSH；SSH 有调度器限并发 |
| IPC | `electron/ipc/register.ts`（`history:*`）、`electron/preload.ts`（`window.anchor.history`）、`src/shared/anchor-api.ts`（`DiffOpenPayload` 等类型） | 新增 `snapshot:*` 通道 |
| diff / 评论 | `src/features/document/DiffViewer.tsx`、`documentStore.ts`、`fileDiffCache.ts`、`src/features/annotations/*`、`electron/services/annotationsService.ts` | 现有 diff 以 `DiffOpenPayload{repoRoot, base, head, files}` 打开单仓；多仓工作台 = `DiffOpenPayload[]` 外加分组 UI |
| agent | `src/features/terminal/AgentSidebar.tsx`、`terminalStore.ts`（`markAgentWorking` / `noteAgentOutput` / `AgentActivityState`）、`electron/services/terminalService.ts`（`host.openPty`）、`agentLaunch.ts`、`agentSessionIdentity.ts` | `working→completed` 状态机即自动快照的触发源；PTY 启动处可注入 env / PATH |
| 主题 | `src/styles/global.css` | `:root[data-theme="light" / "light-modern" / "dark" / "dark-modern"]`，只用 `--bg-* / --text-* / --accent* / --ok* / --warn* / --border*` 变量 |

## 3. UX

### 3.1 快照栏（HISTORY 下方）

```
SNAPSHOTS · 12                     [全部 ▾] [＋ 打点]
──────────────────────────────────────────────────
☐ ● 改完接口           Codex · 第3轮结束   16:52  3 仓 +128 −40
☐ ◆ auto  第3轮开始    Codex              16:41
☐ ★ 16:40              你                 16:40
⚠ 16:41–16:52 期间「你」与 Codex 同时有改动，diff 无法区分归属
```

- 「打点」：单击即打，名称默认 `HH:mm`；按钮旁小箭头可输入名称。
- 来源徽标：`你`（accent）、`auto`（muted）、`Codex` / `Claude`（agent 名，ok 色）。
- 筛选：全部 / 只看手动 / 只看某个 agent。
- 行操作：重命名、删除（右键或悬停图标）。
- 点击一行 = 该点 vs 当前工作区；勾选两行后出现「比较所选」按钮 = 两点之间（旧→新自动排序）。
- 每行附「N 仓变化 +x −y」摘要（打点时顺手算 `--shortstat`，可延迟加载）。

### 3.2 多仓 diff 工作台

文档区新 tab「快照 16:40 → 当前」。左栏按仓分组的文件树（无变化的仓折叠成灰行「api-server · 无变化」），右侧复用 `DiffViewer`。顶栏：基准 / 目标选择器、统计、并发提示条。PR2 起行级评论落到 `repoRoot + path + line`，与现有评论数据完全一致。

### 3.3 agent 条目

`AgentSidebar` 每个 agent 行下展开「改动 · 3 轮」，每轮一条（开始→结束），点击打开同一工作台。

## 4. 数据模型

```ts
type SnapshotSource = "manual" | "auto" | "agent";
interface SnapshotMeta {
  v: 1;
  id: string;            // ULID，时间有序
  workspaceId: string;   // 现有工作区 key
  name: string;          // 默认 "16:40"
  source: SnapshotSource;
  agentId?: string;      // terminal tab id
  agentKind?: "codex" | "claude" | string;
  agentSessionId?: string;
  turn?: { index: number; phase: "start" | "end" };
  createdAt: string;     // ISO
  repos: Array<{
    root: string;        // 相对工作区根的路径
    head: string | null; // HEAD sha（unborn 时为 null）
    branch: string | null;
    tree: string;        // 快照 commit sha（refs/anchor/snapshots/<id>）
    status: "ok" | "skipped" | "error";
    note?: string;       // 如 "LFS pointer only" / "submodule dirty"
  }>;
}
```

**存储决定：双写，git 为真相源，App 存索引。**

- 每仓：`refs/anchor/snapshots/<id>` 指向快照 commit；commit message 首行人类可读，正文是该快照的完整 `SnapshotMeta` JSON。这样 SSH 远端仓库、重装 App、换机器连同一远端都能恢复列表（扫描 `git for-each-ref refs/anchor/snapshots`）。
- App 侧：每个工作区一份 JSON 索引文件 `userData/snapshots/index/<sha1(hostId\0root)>.json`（id→meta），用于秒开列表、筛选；重命名只改索引，不改写 commit（commit 里的旧名仅作恢复兜底）。原计划放 `workspaceState`，实现时改为独立文件：快照数可达数百条，避免撑大 workspaceState。
- 一致性：打开 HISTORY 时后台 `for-each-ref` 对账，补缺失、清悬空。

理由：只放 App 会丢失（重装 / 多台客户端连同一 SSH）；只放 git 每次列表要逐仓读 commit，SSH 下慢。

## 5. git 机制（精确命令）

对每个仓（并行，SSH 受 `openSshScheduler` 限流）在一次 shell 调用里完成，减少往返：

```sh
set -e
cd "$REPO"
GIT_DIR=$(git rev-parse --git-dir)
TMPIDX=$(mktemp "${TMPDIR:-/tmp}/anchor-idx.XXXXXX")
trap 'rm -f "$TMPIDX"' EXIT
HEAD=$(git rev-parse -q --verify HEAD || true)
# 以当前 index 为起点，保留用户已暂存内容的语义，再加入工作区全部改动
cp "$GIT_DIR/index" "$TMPIDX" 2>/dev/null || true
GIT_INDEX_FILE="$TMPIDX" git -c core.autocrlf=false add -A -- . ':!:.anchor'   # 含未跟踪、尊重 .gitignore
TREE=$(GIT_INDEX_FILE="$TMPIDX" git write-tree)
PARENT=${HEAD:+-p $HEAD}
SNAP=$(printf '%s\n\n%s\n' "anchor snapshot $NAME" "$META_JSON" \
  | GIT_AUTHOR_NAME=anchor GIT_AUTHOR_EMAIL=anchor@local \
    GIT_COMMITTER_NAME=anchor GIT_COMMITTER_EMAIL=anchor@local \
    git commit-tree $TREE $PARENT)
git update-ref "refs/anchor/snapshots/$ID" "$SNAP"
echo "$HEAD $TREE $SNAP"
```

要点：
- **不用 `git stash create`**：它不含未跟踪文件，`stash -u` 又会改工作区。临时 `GIT_INDEX_FILE` 方案对用户 index / worktree 零副作用，hook 不触发（`commit-tree` 不跑 hook，也不需要 `user.name`）。
- 父提交 = HEAD，所以「快照 vs HEAD」也能看出未提交改动；agent 中途提交过也会被比较覆盖（比较的是 tree）。
- **比较**：
  - 点 vs 当前：先对当前工作区同样做一次临时 tree（不建 ref，`write-tree` 即可），然后 `git diff --name-status -M <snap> <curTree>`；也可直接 `git diff <snap>` + 未跟踪补齐（复用 `compareToWorktree` 逻辑），MVP 采用前者，结果更准确（含未跟踪、删除）。
  - 两点之间：`git diff --name-status -M refs/anchor/snapshots/A refs/anchor/snapshots/B`。
  - 文件内容：`git show <sha>:<path>`（复用 `gitShow`/`getFileDiff`）。
- **不推送**：`refs/anchor/*` 不在默认 `refs/heads/*`、`refs/tags/*` 推送范围；`git push --mirror` / `--all` 之外不会带出。打点前检查 `remote.*.push` / `remote.*.mirror`，若配置为 `refs/*` 或 mirror，则在 UI 警告并（可选）改用 `$GIT_DIR/anchor-snapshots` 下的独立存储。同时会保护 gc：ref 可达对象不会被清。
- **删除 / 清理**：`git update-ref -d refs/anchor/snapshots/<id>`；对象交给正常 gc。

## 6. 边界情况

| 情况 | 处理 |
|---|---|
| 非 git 目录 | 不参与，工作台中不出现；若工作区根本身不是仓，提示「无仓可快照」 |
| 新增仓（快照后才出现） | 比较时该仓一侧缺失 → 整仓按「全部新增」展示并标注「快照后新增」；删除的仓同理 |
| submodule | 父仓记录 gitlink sha；子模块若在工作区内被 `discoverRepos` 发现则作为独立仓快照。dirty 子模块在父仓标 note |
| LFS | `add -A` 走 clean filter，存的是 pointer；diff 显示 pointer 变化 + 标注「LFS」，不拉取大对象 |
| 大文件 / 二进制 | **已定**：> 5 MB 的未跟踪文件不进 tree，但把路径、大小、mtime 指纹写进 meta 的 `largeFiles`。diff 中照常列出，带「大文件，未记录内容」徽标；打开只显示名字、大小、状态（新增/修改/删除，按 size/mtime 判断），绝不静默丢弃。已跟踪的大文件照常入 tree |
| unborn HEAD（新仓无提交） | `HEAD=null`，commit 无父 |
| 冲突 / rebase / merge 进行中 | 照常快照 tree（unmerged 条目 `add -A` 后会以工作区内容为准），note 标记「merge in progress」 |
| index.lock 存在 | 我们不写真实 index，不受影响；`add -A` 写临时 index 无锁冲突 |
| SSH 延迟 | 每仓一次 round-trip 脚本；所有仓并行；整体超时 30 s，单仓失败记 `status:"error"` 不阻塞其他仓 |
| 并发改动 | 记录每个快照区间内有哪些来源活跃（人有无编辑器保存事件、多个 agent 是否同时 working）；重叠时在列表和工作台顶部给 warn 条，不做归属 |
| 保留策略 | **已定**：手动快照永久；auto 每工作区最近 500 个或 30 天（超出任一即清）；agent 打的 30 天。打点后同步计算并删除 ref + 索引项 |
| 性能 | `add -A` 成本 ≈ `git status`；大仓沿用现有 `untrackedFilesMode` 的阈值判断，超大时提示并允许只快照已跟踪文件（`add -u`） |

## 7. IPC / API

`window.anchor.snapshot`（preload）→ `snapshot:*`（register.ts）→ `snapshotService.ts`：

```ts
create(args: { workspaceRoot: string; name?: string; source: SnapshotSource;
  agentId?: string; turn?: {...} }): Promise<SnapshotMeta>
list(workspaceRoot: string): Promise<SnapshotMeta[]>        // 索引 + 后台对账
rename(args: { workspaceRoot: string; id: string; name: string }): Promise<void>
remove(args: { workspaceRoot: string; ids: string[] }): Promise<void>
compare(args: { workspaceRoot: string; base: string; target: string | "worktree" })
  : Promise<MultiRepoDiffPayload>
getFileDiff(args: { repoRoot: string; base: string; target: string; path: string })  // 复用 history:getFileDiff
onChanged(cb): () => void   // snapshot:changed 事件，CLI 打点后刷新列表

interface MultiRepoDiffPayload {
  workspaceRoot: string; base: SnapshotRef; target: SnapshotRef | "worktree";
  repos: Array<DiffOpenPayload & { state: "changed" | "unchanged" | "added" | "removed" | "error" }>;
  overlapWarning?: string;
}
```

## 8. agent 主动打点机制（`anchor snapshot`）

**传输：文件投递（file drop），不用 socket。** 原因：SSH 工作区里 agent 跑在远端，远端到本机没有反向通道；而 App 已经能在远端执行命令、监听文件（`fileWatcherService`）。

1. App 启动 agent PTY 时（`terminalService` → `host.openPty` 的 env）注入：
   - `ANCHOR_SNAPSHOT_DIR=<workspaceRoot 的 git-dir 外的位置，例如 ~/.anchor/snapshot-requests/<workspaceId>>`
   - `ANCHOR_AGENT_ID=<tab id>`
   - `PATH=~/.anchor/bin:$PATH`
2. App 在主机上（Local/WSL/SSH 都通过 `host.run`）安装一个 POSIX sh 小脚本 `~/.anchor/bin/anchor`（Windows 本地另放 `anchor.cmd`）。`anchor snapshot "msg"` 原子写入 `$ANCHOR_SNAPSHOT_DIR/<ts>-<rand>.json`（先写 `.tmp` 再 `mv`），内容 `{agentId, name, cwd}`，然后最多等待 10 s 轮询同名 `.done` 文件，打印快照 id。
3. App 侧：本地 / WSL 用文件监听，SSH 用现有轮询节奏（2 s，空闲退到 10 s）`ls` 该目录；读取后执行 `snapshot.create({source:"agent"})`，写 `.done`，删请求文件。
4. 技能：在现有 skill 安装（`skillInstall.ts`）里加一段说明，告诉 Claude Code / Codex「做阶段性大改前后执行 `anchor snapshot "<一句话>"`」。没有该命令时（如用户在外部终端）脚本不存在，agent 会忽略。

安全：请求文件只含名字，App 只做打点，不执行任何内容；名称截断 80 字符。

## 9. 自动快照触发

复用 `terminalStore` 的 agent 活动状态机：

- **开始**：`markAgentWorking(id)`（用户在 agent tab 提交 prompt，`idle→working`）时，先同步发 `snapshot.create({source:"auto", turn:{phase:"start"}})`。为不拖慢输入，打点异步进行，但 PTY 写入不等它；开始快照的时间戳取发起时刻。由于 agent 首个文件改动通常在数秒后，竞态窗口可接受；在元数据里记录 `createdAt` 与完成时间，若完成前已检测到文件变更（`fileWatcherService`）则标 note。
- **结束**：`working → completed-unread / idle`（`noteAgentOutput` 的 2.5 s 静默定时器触发）或 PTY 退出时打 `end`。
- 去抖：同一 agent 两次 start 间隔 < 5 s 且中间没有 end 时合并；结束快照若与开始快照所有仓 tree 相同，仅在 meta 记 `empty: true`，不改名、不在列表提示（单个快照没有 diff，改动信息只在两点比较中出现）。
- 设置项：`Settings → Agent → 自动快照` 开关（默认开）。

## 10. 多仓 diff 工作台

- 新文档 tab 类型 `snapshot-diff`，在 `documentStore` 中以 `{kind:"snapshot-diff", base, target}` 持久化，重启可恢复。
- 左栏：仓分组 → 文件列表（沿用 Git changes 面板的文件行样式与 A/M/D/R 徽标）；`unchanged` 仓折叠为一行。
- 右侧：选中文件时用现有 `DiffViewer`，内容来源 `snapshot.getFileDiff`，缓存复用 `fileDiffCache`（key 加 snapshot sha）。
- 评论（PR2）：评论锚点 = `{repoRoot, path, line, side}`，与现有 annotations 结构一致；在 target=`worktree` 时评论直接落到当前文件，target 为历史快照时以只读方式附带 `snapshotId`，并在文件变化后用现有锚点漂移逻辑迁移。

## 11. 分期

**PR1（MVP）**：`snapshotService`（create / list / rename / remove / compare）、`snapshot:*` IPC、HISTORY 快照栏（打点、列表、来源徽标、筛选、重命名、删除、单选 / 双选比较）、自动 start/end 快照、只读多仓 diff 工作台、并发提示、基础保留上限。

**PR2**：工作台内行级评论、`anchor snapshot` CLI + 文件投递 + 技能说明、AgentSidebar「改动 · N 轮」入口、保留策略设置、push 配置检查与 LFS / 大文件 note 打磨。

## 12. 测试计划

- 单元（vitest，`snapshotService.test.ts`）：临时 git 仓构造 已暂存 / 未暂存 / 未跟踪 / 忽略 / 删除 / 重命名 / unborn / 二进制，断言快照 tree 内容正确且用户 `index`（比较 `.git/index` 哈希）与工作区未变；`refs/anchor/*` 存在；`git push` 到裸仓后远端无该 ref。
- 多仓：工作区含 3 仓 + 1 非 git 目录 + 快照后新增仓，`compare` 的分组和状态。
- 触发：`terminalStore` 状态机 → 自动快照调用次数、去抖、empty 标记。
- WSL / SSH：沿用现有 `*.wsl.smoke.test.ts` / ssh mock host，验证单次 round-trip 与单仓失败隔离。
- UI：`HistoryPane.test.tsx` 增加快照栏渲染、勾选两项启用「比较所选」；四套主题截图（light / light-modern / dark / dark-modern）。

## 13. 待确认问题

1. 自动快照默认开启？每轮 2 个点会让列表变长，→ 已定：默认开启，列表只显示 owner 标签（你 / auto / agent 名），可按来源筛选。
2. ~~保留上限~~ → 已定：auto 500 个 / 30 天，manual 永久，agent 30 天。
3. ~~大文件阈值~~ → 已定：> 5 MB 未跟踪文件跳过内容、保留名字/大小/mtime（见 §6）。
4. 当仓库配置了 mirror / `refs/*` 推送时，是警告还是自动改用不进 refs 的存储？


## 14. 已定决策与 PR1 实现（2026-11）

1. 自动快照同样出现在 HISTORY → 快照 区，保留来源筛选（全部 / 手动 / 自动 / Agent）。
2. 保留：auto 500 个或 30 天；manual 永久；agent 30 天。
3. 大文件：见 §6，`largeFiles` 元数据 + 徽标 + 只读信息页。
4. **外部快照存储**：若仓库存在 `remote.*.mirror=true` 或任一 `remote.*.push` refspec 覆盖 `refs/anchor/*`（如 `refs/*:refs/*`），快照不写入仓库 refs，而是写入 app 数据目录下的裸仓：本机 `userData/snapshots/stores/<sha1(hostId+root)[:16]>.git`，SSH/WSL 远端 `~/.anchor/snapshots/<hash>.git`。该裸仓 `objects/info/alternates` 指向用户仓 objects；打点时用 `GIT_OBJECT_DIRECTORY=<store>/objects` + `GIT_ALTERNATE_OBJECT_DIRECTORIES=<repo>/objects`，新对象只写进 store，不碰用户仓；读取 diff 时反向把 store objects 作为 alternates。用户仓 `gc --prune=now` 不影响快照（测试覆盖）。已知风险：快照借用的用户仓已有 blob，若用户改写历史并 gc，可能丢失；Windows 本机 alternates 分隔符 `;` 已处理。
5. 文档保留在 `docs/design/`（仓库 `.gitignore` 忽略 `docs/`，本文件为强制添加）。

### PR1 已实现
- `electron/services/snapshotService.ts`：create / list / rename / delete / compare / retention；多仓并发（上限 6），单仓失败隔离（标记 error，其余照常）；Local / WSL / SSH 通过 host `RunOptions.env`（远端用 `env K=V cmd` 前缀）。
- 打点用临时 index（复制真实 index → `add -A` → `write-tree` → `commit-tree` → `update-ref refs/anchor/snapshots/<id>`），用户 index、status 不变。
- IPC `snapshot:*`、preload `window.anchor.snapshot`、共享类型 `src/core/snapshots/model.ts`。
- HISTORY 快照区：打点（可选命名）、筛选、重命名、删除、勾选两个比较（按时间旧→新）、单击 = 与当前工作区比较、跨 agent / 部分重叠提示。
- 自动快照：agent 轮次开始/结束（`agentActivity` 进入/离开 working，tab 退出或关闭算结束）；Settings → Agent「自动快照」开关（默认开）；5 秒内重复开始合并；无改动的结束快照只在 meta 记 empty，不在名字或列表中提示。
- 快照列表：每行只显示名字、时间和右对齐的 owner 标签（与 Git 面板「M」徽标同一样式，按 owner 着色）；失败详情只在悬停提示中。
- 索引自愈：索引文件缺失或损坏时，从各仓及其外部存储的 `refs/anchor/snapshots/*` 提交信息（内含 meta JSON）重建并写回；重命名只存在索引中，重建后恢复为创建时的名字。
- 只读多仓 diff tab：按仓分组，无变化仓折叠，快照后新增仓标注，大文件徽标与信息页。

### 未在 PR1（后续）
- `anchor snapshot` agent 命令、评论、agent 条目跳转（PR2）。
- 未在真实 Electron / SSH 远端上手测，仅单测 + 组件截图。
