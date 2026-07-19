# Anchor Code

状态：已出 design  
更新日期：2026-07-19

## 当前共识

### 产品是什么

Anchor Code 的 **目的** 是加强 **AI coding 时的人在回路（human-in-the-loop）**：让人更方便、更细致地 **审计** AI 的产出，并把 **反馈** 清楚交回给 AI（例如终端里的 CLI agent）。它不是通用 IDE，也不是全自动 agent 产品；读、比、批、终端都是服务这条回路的手段。

产品形态上，它是面向 Linux、macOS，以及 Windows 上经 SSH 使用 WSL 的 **本地桌面审计/反馈工作台**：默认阅读，编辑明确降级。主路径可以概括为——在工作区里细读代码与 Markdown、在 Git 区对照任意两笔 commit（审计变更）、在源码/文档选区高亮批注并把 session YAML 路径交回 AI、用多标签终端与 AI CLI 同一上下文协作。云同步、账号、托管平台 PR 同步、完整 IDE 生态，都不是当前目标。

历史材料在 `~/anchor-code-proposal`（设计文档、实现计划、参考截图、demo worktree）。新工程从 `~/anchor-code` 重新开始：UI 按现有参考风格 **完整重做**，可继承信息架构与领域结论，不要求迁就 demo 的实现与 mock 数据。

### 平台与执行模型

UI 跑在各桌面端的 Electron 应用里。真正碰仓库、git、文件系统、shell 与 AI CLI 的是 **执行端（HostSession）**：

- **macOS / Linux**：执行端即本机（`child_process` + 本地 PTY）。
- **Windows**：应用跑在 Windows 上，代码与 AI CLI 在 **WSL**；通过 **SSH** 连到 WSL，而不是在 Windows 本机拧 path/pty，也不优先支持 `\\wsl$\` 式混用。

产品能力共用一套；跨端差异收在「Local HostSession vs SSH HostSession」两条实现里。路径、cwd、git、terminal、读写 `.anchor-code` 一律用 **执行端视角** 的路径。Windows 上 v1 倾向 **只认 WSL 内路径**，不承诺同时管 Windows 原生路径仓库。

第一阶段不需要完整 VS Code Remote 协议，只要薄抽象，例如：跑命令、开 PTY 流、读文件/列目录。打开工作区即打开执行端上的目录；终端、git、评论读写都相对该工作区/其下仓库。

### 信息架构与 UI 方向

整体气质仍是阅读优先的审阅台，不是厚 IDE。布局与视觉 **主参考** 为 `docs/anchor-code/ui-reference.png`（用户更新的壳层图）：

`顶栏 Open/Search/Toggle Terminal | 左 FILES·COMMENTS·HISTORY(GIT) | 中文档 tabs + 阅读面 | 右 TERMINAL 多标签`

- **左侧**：带图标与文案的模式列表 + 文件树（或 Comments / History 内容）；底可有 branch 状态占位。
- **中央**：打开项 tabs + 文档/代码/diff；**不承载多仓库切换**。
- **右侧**：**Terminal** 多标签（参考图已体现），可 Toggle 收起。
- 浅色、细边线、flat-first；MD 默认 rendered。旧 proposal 截图仅历史对照，**冲突以 ui-reference.png 为准**。

### 工作区、多仓库与 Terminal（对齐 VS Code 心智）

**打开方式**：与 VS Code 类似——打开的是 **工作区或代码目录路径**（执行端上的 folder）。不是先抽象出一套与目录脱节的「仓列表产品」。

**多仓库**：

- 多 repo 的感知 **只出现在 Git 区域**（左栏 History / 源码管理一类视图）：例如工作区下发现多个 git root 时，在 Git 区列出并选择在哪个仓上做 log / compare。
- **中间区不感知多 repo**：打开文件就是路径对应的阅读面；不在中央做仓切换器、不按「active repo」重绘整棵编辑心智。
- 文件树按工作区目录展示即可（类 VS Code Explorer）；git 元数据与 compare 范围由 Git 区选定的仓库决定。

**Terminal**：

- 逻辑对齐 VS Code：打开工作区/目录后，终端 cwd 就是该工作区（或对应代码目录）路径；多标签管理（新建/关闭/切换）即可。
- 不单独发明复杂的「终端与 active repo 强绑定状态机」；跟工作区路径走即可。
- 实现：本机 node-pty 一类；Windows→WSL 走 SSH shell。渲染 xterm.js。第一阶段普通 shell，不做 AI 编排 UI。

**添加/打开工作区的最小方案**（已同意）：选执行端上的目录；若需 git 能力则检测 git root（工作区下可有多 root，交给 Git 区）；SSH/WSL 连接配置放在应用设置（或等价本地配置），不必第一阶段做厚引导向导。

### 第一阶段要立住的能力（区域占位）

实现策略：**先划好区域，每区有可用占位**，再加深。

**1. Git 区：历史 + 任意两 commit 比较 + 多仓列表**

「Git Graph」在本产品中的真实含义 **不是** 优先做 branch lane 拓扑画图，而是：

- 在 Git 区看到工作区相关的 repo（多仓时在此切换/点选要操作的仓）；
- 该仓的 commit 列表可浏览（hash、message、author、date 等即可）；
- **勾选两个 commit，再执行比较** → 得到文件列表 + 可读 diff（中央用 Monaco DiffEditor 等展示）。
- 实用上仍希望支持某 commit 对 worktree 的 diff；拓扑可视化图第一阶段不做、不为此拉画图库。

标签语义示例：`a1b2c3 → d4e5f6`。数据来自执行端 `git log` / `git diff`。

**2. 代码与 Markdown 阅读**

打开工作区内文件即可读：代码高亮只读；Markdown 默认 rendered，可切 raw。编辑非第一阶段重点。

**3. 评论 / 高亮批注（一级能力）**

- 在 **代码与 Markdown** 上均可：选中片段 → 高亮 → 添加评论（同一阶段都做，不拆成两刀）。
- 高亮块 **悬停** 可看摘要/预览。
- **侧栏 Comments** 浏览线程并跳转回源位置。
- **同一时刻只支持一个活跃 session**（单 session 模型）：不并行多个 active session；持久化仍落在仓库内 `.anchor-code/` 的 YAML，人类可读、Git 友好，**YAML 为唯一事实来源**。
- 锚点：路径 + 行列 + 选中文本 + 前后文，文件变更后尽力重定位。
- 批注优先落在 **当前 worktree 源文件**；diff hunk 批注后置。
- 评论数据落在对应 **git 仓库** 的 `.anchor-code/` 下（哪个仓的文件就写哪个仓）。

**导出给 AI（收窄后的形态）**：不强制做精美 Markdown brief 生成器；**方便复制 session 的 YAML 路径** 即可（用户把路径交给终端里的 AI CLI 或自行打开）。需要时路径可一键复制到剪贴板。

实现：Monaco decorations（及 MD 侧对应高亮）+ YAML session（zod 等）；不引入完整第三方 review 套件。

**4. 右侧多标签 Terminal**

见上文：工作区路径为 cwd、多标签、普通 shell；与评论的衔接靠「复制 YAML 路径 → 在终端里喂给 AI」。

### 技术方向（讨论级，非详细设计）

- 桌面：Electron + React + TypeScript。
- 分栏：如 react-resizable-panels（左 / 中 / 右，右为 Terminal）。
- 代码与 diff：Monaco（含 DiffEditor）。
- Markdown：react-markdown + GFM 等。
- Git：执行端系统 `git` CLI；多仓发现与 compare 状态放在 Git 区模型里，不塞进中央文档模型。
- 终端：xterm.js + 本地 PTY 或 SSH。
- 远程：ssh2 或系统 ssh；配置在应用设置。
- 状态：如 zustand；评论 schema：zod + yaml。

### 明确非第一阶段（或明确降级）

- 拓扑 Git Graph 可视化库与 lane 美学。
- 中央区多仓切换 UI、以「active repo」驱动整窗信息架构。
- 完整编辑、调试、扩展市场。
- 云同步、账号、实时协作、托管平台 review 同步。
- Diff hunk 级批注。
- 终端内深度 AI 产品化；复杂导出 brief（路径复制已够）。
- 多 active session 并行。
- 知识图谱 / Obsidian 式网络。

### 和历史材料的关系

| 来源 | 用法 |
|------|------|
| proposal 设计文档 | 产品定位、阅读优先、评论 YAML 方向 —— 主参考；布局上右侧从「Review inspector」调整为 **Terminal** |
| 参考截图 | 浅色审阅气质、左中内容密度；右侧用途按本讨论改为终端 |
| demo worktree | 参照，非代码基线 |
| 旧「先 Mac」 | 已更新为三端 + WSL via SSH |
| 旧文「Git Graph」 | 已澄清为 Git 区历史 + 勾选两 commit 比较，非画图 |
| 旧「多仓驱动整窗」设想 | **已修正** 为 VS Code 式：多仓只在 Git 区感知，中央不感知 |

---

## 开放问题

当前轮次已拍板项已写入共识。实现前若再需要细化、且尚未定稿的仅剩边角，例如：

- commit↔worktree 是否与「勾选两 commit」同一入口并列展示，还是菜单次级动作；
- 单 session 下「结束/新建」是否第一阶段就要 UI，还是固定一个 `active` 文件先跑通；
- 工作区下多个 `.anchor-code`（多 git root 各有一份）时，Comments 侧栏默认聚合还是跟随「当前打开文件所属仓」。

这些不阻塞进入 proposal/设计，可在设计或实现切片时再定。

---

## 演进史

- **2026-07-19（初稿）**：从 proposal/demo 重启讨论。平台改为 Linux / macOS / Windows-WSL（SSH）。纠正 Git Graph = 画图；强调任意两 commit diff、多仓、评论一级能力、普通多标签终端。UI 完整重做。

- **2026-07-19（收敛开放问题）**：Terminal 对齐 VS Code——随工作区/代码目录路径打开即可。多仓对齐 VS Code 心智：**仅 Git 区感知多 repo，中央区不感知**。评论定为 **同时刻仅单 session 活跃**；代码与 Markdown 批注同一阶段都做；导出给 AI **以方便复制 YAML 路径为准**。Compare 交互定为 **勾选两个 commit 再比较**。右侧栏第一阶段 **放置 Terminal**（不再把右侧留给 Review inspector 占位）。工作区打开/SSH 配置采用先前最小方案。

- **2026-07-19（出 proposal）**：依据当前共识编写 `docs/anchor-code/PROPOSAL.md`。讨论状态改为「已出 proposal」。开放问题中的边角仍留待设计阶段默认，不阻塞提案。

- **2026-07-19（纠正产品目的）**：提案初稿把目标写成偏「通用本地审阅工作台」，不准确。真正目的是 **加强 AI coding 的人在回路**——更方便、细致地审计 AI 产出并反馈回去。已改写 `PROPOSAL.md` 问题定义、场景、原则与成功标准，并同步本共识「产品是什么」；能力切片不变，叙事主轴改为 HITL。

- **2026-07-19（出 design）**：按完整结构撰写 `docs/anchor-code/DESIGN.md`（Host/模块/HITL 主回路/Git 双选/Comments/Terminal/切片与设计默认）；图用 Mermaid + ASCII。讨论状态改为「已出 design」。

- **2026-07-19（UI 主参考图）**：用户提供新壳层截图，存为 `docs/anchor-code/ui-reference.png`。DESIGN / PROPOSAL / 本共识改为以该图为 UI 主参考（右 Terminal、左三模式带标签、中 Rendered 文档）；旧 proposal 截图降为历史对照。
