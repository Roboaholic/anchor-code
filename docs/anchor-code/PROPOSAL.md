# Anchor Code — Proposal

状态：已有 design  
日期：2026-07-19  
依据：`docs/anchor-code/DISCUSSION.md`（当前共识）  
前序材料：`~/anchor-code-proposal`（旧设计、参考截图、demo；本提案在其审阅定位上重启，不以 demo 代码为基线）

## 要解决什么问题

**核心目的：加强 AI coding 过程中的「人在回路」（human-in-the-loop）**——让人能更方便、更细致地审计 AI 的产出，并把反馈清楚交回给 AI，而不是在「全自动生成」和「回到沉重 IDE 里手工改」之间空转。

今天常见的别扭之处：

- AI CLI / agent 改完一堆文件后，人在终端滚动日志或跳回 IDE，**缺乏专为审计设计的阅读与对照面**；
- 想看清「AI 这一轮相对哪次基线改了什么」，任意 commit / worktree 对比链路长，反馈点难以钉在具体选区上；
- 人对某段代码的意见散落在聊天里，**难以结构化、可回看、可再次喂给 AI**；
- 完整 IDE 默认编辑噪音大；纯聊天或纯 PR 网页又 generically 不贴「本地 AI 改仓 + 人逐段把关」这条回路。

因此缺口不是「再做一个通用代码审阅器」，而是：**在 AI 写代码的工作流里，给人一把更顺手的审计与反馈工具**——读得细、比得清、批得上、反馈回得去。

## 提案概要

构建跨端桌面应用 **Anchor Code**：服务 **AI coding 的人在回路**。人打开执行端上的工作区，在统一壳层中完成审计与反馈；AI 仍主要通过终端侧 CLI 工作，本产品不取代 agent，而是让人的把关更细、交接更省事。

能力落点（均为回路服务，而非通用 IDE 功能堆砌）：

1. **阅读面**：代码只读高亮、Markdown 默认渲染——便于细读 AI 改过的实现与方案文档；
2. **Git 对照**：工作区下多仓仅在 Git 区呈现；勾选两笔 commit 比 diff——便于审计「这一轮 / 相对某基线」的变更；
3. **批注反馈**：选区高亮、悬停预览、侧栏跳转；仓库内 YAML 单活跃 session；**复制 YAML 路径**交回 AI CLI——把人的细致意见结构化交回回路；
4. **多标签终端**：cwd 跟随工作区（对齐 VS Code）；右侧面板——人与 AI CLI 同一工作上下文，不另起一套 agent UI。

第一阶段策略是 **分区先立住、每区可用**，再加深。UI 按现有参考风格（浅色、阅读优先）**完整重做**，不延续 demo 的 mock 实现。编辑明确次要：人的主操作是审计与反馈，不是把本应用当成主编辑器。

## 目标用户与典型场景

- 重度使用 Claude Code、Codex 等 **本地/远程 CLI agent** 写代码，需要自己对 diff 与关键片段做把关的人；
- 希望反馈是 **钉在代码/文档选区上的批注**，而不是仅凭聊天记忆；
- 在 Linux / macOS，或 Windows 上代码在 WSL 的环境中，希望同一套「人审 + AI 改」回路。

典型回路示例：

1. 右侧终端让 AI CLI 改代码或实现某变更；
2. 人在 Git 区勾选基线 commit 与当前点（或对 worktree）看 diff，细读中央变更；
3. 在可疑或需改的选区高亮写评论（代码与 Markdown 均可）；
4. 复制 session YAML 路径，在终端里让 AI 读取并按批注修改；
5. 再比一轮 diff / 再批注，直到人满意。

## 平台范围

| 桌面 UI | 执行端（git / 文件 / shell / AI CLI） |
|---------|--------------------------------------|
| macOS | 本机 |
| Linux | 本机 |
| Windows | **WSL，经 SSH**（应用在 Windows，工作与路径在 WSL） |

跨端差异收敛为 **HostSession** 抽象：`Local` 与 `SSH` 两套实现；业务功能共用。路径一律为执行端视角。Windows v1 **不承诺**管理 Windows 原生路径仓库，只认 WSL 内路径。

不在本提案范围：完整 VS Code Remote 协议、云账号、实时协作。

## 产品原则

1. **人在回路优先**：一切能力服务「人审计 AI 产出 → 给出细致反馈 → AI 再改」；不是做通用 IDE，也不是做全自动 agent 产品。
2. **审计面默认阅读**：默认阅读与对照；编辑若有，必须显式，且非 v1 主路径——人在本应用里的主操作是看清与批注。
3. **反馈必须可交回 AI**：批注高亮 + 侧栏 + **可复制的 session YAML 路径**是一等公民；没有「只能人看、AI 吃不到」的死胡同。
4. **中央只承载内容**：文档 / 代码 / diff；**不**在中间区做多仓库切换或「当前 repo」工作区级 chrome。
5. **多仓只在 Git 区感知**：对齐 VS Code 式工作区；多个 git root 时在 Git 区选定对照对象。
6. **终端保持薄**：多标签 shell、cwd = 工作区即可；AI 仍跑在 CLI 里，本应用不先做深度 agent 编排 UI。
7. **仓库内、Git 友好的状态**：评论 YAML 落在对应 git 仓 `.anchor-code/`，可版本管理、可给 AI 读文件。

## 信息架构（v1）

```text
┌─ Command bar ─────────────────────────────────────────────┐
│  打开工作区 / 搜索与全局动作（克制）                         │
├─ Navigator ──────┬─ Document / Diff ────────┬─ Terminal ──┤
│ Files            │  打开的 MD / 代码 / diff  │  多标签 shell │
│ Comments         │  （不感知多 repo）         │  cwd=工作区  │
│ History (Git)    │                           │  可收起      │
└──────────────────┴───────────────────────────┴─────────────┘
```

视觉与壳层以仓库内 **`docs/anchor-code/ui-reference.png`** 为唯一主参考（顶栏 Open/Search/Toggle Terminal；左 FILES·COMMENTS·HISTORY；中文档 tabs + Rendered 阅读；右多标签 Terminal）。浅色、细边线、flat-first；不要求像素级复制，但分区与控件角色应对齐该图。右侧为 **Terminal**，不是 Review inspector / Agent 大面板。

## 功能范围

### 包含（第一阶段 / v1 目标切片）

**工作区**

- 打开执行端上的目录作为工作区；应用本地记住最近工作区。
- 文件树按工作区展示；SSH/WSL 连接信息放在应用设置。

**Git（History 区）**

- 发现工作区下 git root；多仓时在 **本区** 选择当前操作的仓库。
- Commit 列表（hash、message、author、date 等）。
- **勾选两个 commit → 比较**：中央展示变更文件列表与 diff（如 Monaco DiffEditor）。
- 期望支持 commit ↔ worktree 的 diff（入口形态可在设计阶段与双选并列或次级动作定稿）。
- **不做** 拓扑 Git Graph 画图库整合。

**阅读**

- 代码：只读、语法高亮。
- Markdown：默认 Rendered，可切 Raw。

**评论**

- 代码与 Markdown **均支持**：选区 → 高亮 → 写评论。
- 悬停高亮看预览；Comments 侧栏列表与跳转。
- **同时刻仅一个活跃 session**；数据在对应仓库 `.anchor-code/*.yaml`；YAML 为唯一事实来源。
- 锚点：路径、行列、选中文本、前后文（变更后尽力重定位）。
- 范围：优先 worktree 源文件；diff hunk 批注不做。
- 给 AI：提供 **复制 session YAML 路径**（剪贴板），不强制生成 Markdown brief。

**终端**

- 右侧多标签；新建 / 关闭 / 切换。
- cwd 为工作区（或所打开代码目录）路径，心智对齐 VS Code。
- 本机 PTY 或 SSH shell；无内置 AI 会话产品。

### 不包含（明确非目标 / 后置）

- 通用 IDE 能力（调试、扩展市场、完整语言服务优先等）
- 云同步、账号体系、实时协作评论
- GitHub / GitLab PR review 同步
- 拓扑 commit graph 可视化作为主路径
- 中央多仓切换 UI
- 多 active session 并行
- Diff hunk 级批注
- 终端内深度 AI 编排、自动注入上下文的 agent UI
- Obsidian 式知识图谱
- Windows 原生路径仓库与 WSL 混管（v1）

## 技术方向（提案级，细节留给设计）

| 层级  | 方向                                            |
| --- | --------------------------------------------- |
| 壳   | Electron + React + TypeScript + Vite          |
| 分栏  | 可拖拽三栏（左 / 中 / 右 Terminal）                     |
| 执行端 | HostSession：Local（spawn + PTY）/ SSH（WSL）      |
| Git | 执行端 `git` CLI；compare 状态属 Git 区模型             |
| 编辑器 | Monaco 阅读与 Diff；MD 用 react-markdown + GFM 等   |
| 终端  | xterm.js + node-pty 或 SSH channel             |
| 评论  | zod 校验 + YAML 读写；Monaco decorations / MD 高亮投影 |
| 状态  | 轻量客户端状态（如 zustand）                            |

代码库：`~/anchor-code` 新开；可参考旧 demo 的领域形状，**不**以拷贝 demo 为交付前提。

## 成功标准（第一阶段可验收）

成功不定义为「功能清单点满」，而定义为 **能跑通一条 AI coding 的人在回路**：

在目标平台之一（建议先 Mac 或 Linux 本地 Host，再接通 Windows→WSL SSH）上，用户能够：

1. 在右侧终端对工作区使用 AI CLI（或模拟其改文件），人能在同一应用内打开工作区细读代码与 Markdown；
2. 在 Git 区勾选两笔 commit（或等价对照）看清 AI 相关变更 diff；
3. 在具体选区写下批注（代码与 Markdown），高亮 / 悬停 / 侧栏可回看；session YAML 持久化；
4. **复制 YAML 路径并在终端中交回 AI**（人可完成「按批注再改」的交接，无需另做 brief 生成器）；
5. 界面是阅读与审计向，而非 IDE 编辑驾驶舱；中央无多仓切换控件。

## 风险与依赖

- **SSH + PTY 在 WSL 上的稳定性**（键位、窗口尺寸、断线重连）是 Windows 路径的主要工程风险；HostSession 边界必须清晰以便单测本地、集成测 SSH。
- **评论锚点**在文件大改后会漂移；混合锚点是 best-effort，需在 UX 上允许「失锚」提示，避免静默错位。
- **多 git root + 多份 `.anchor-code`** 时，Comments 侧栏默认聚合还是随当前文件所属仓——讨论中留为边角，设计阶段需给默认以免实现分叉。
- 不绑定托管平台意味着 **全部信任本地 git 与用户 shell**；安全模型保持「本地工具」预期即可，但仍需避免把 SSH 私钥写进仓库。

## 建议的后续步骤

1. 审阅并确认本提案（范围与非目标）。
2. 撰写 `DESIGN.md`：模块边界、HostSession API、评论 YAML schema、Git compare 状态机、UI 组件树与关键交互（含勾选两 commit、单 session 生命周期默认）。
3. 再拆实现计划 / PR 切片：壳与 Host → 工作区与阅读 → Git compare → 评论 → 终端 → Windows SSH 加固。

## 与讨论结论的对应关系

本提案固化 `DISCUSSION.md` 中的能力与约束共识（WSL=SSH、双 commit 比较、多仓仅 Git 区、右侧 Terminal、单 session、代码+MD 批注、复制 YAML 路径、UI 重做等）。**产品目的表述已按后续纠正对齐为：加强 AI coding 的人在回路（细致审计与反馈）**——读/比/批/终端是手段，不是「再做一个通用审阅 IDE」本身。讨论中未闭合的边角仍由设计文档给默认。
