# Handoff — Anchor Code 开工说明

给下一个 agent / 实现者：本文是 **可独立阅读的开工交接**。细节以同目录三份文档 + 参考图为准；冲突时优先级如下。

## 0. 先读什么（顺序）

| 顺序 | 路径 | 用途 |
|------|------|------|
| 1 | `docs/anchor-code/ui-reference.png` | **UI 壳层唯一主参考** |
| 2 | `docs/anchor-code/DISCUSSION.md` | 共识与演进（HITL 目的、多仓只在 Git 区等） |
| 3 | `docs/anchor-code/PROPOSAL.md` | 范围、非目标、验收 |
| 4 | `docs/anchor-code/DESIGN.md` | 模块、Host、主回路、schema、切片 |
| 5 | 本文 | 开工约束与第一刀 |

历史材料（**不要当布局基线**）：`~/anchor-code-proposal`（旧设计、旧截图、demo worktree）。评论 YAML 形状可参考旧设计；**壳层以 `ui-reference.png` 为准**。

当前仓库 **几乎无应用代码**（仅 `docs/` + 参考图）。在仓库根 `~/anchor-code` **从零脚手架**，不要拷贝 demo 当基线继续堆。

---

## 1. 产品一句话（勿偏题）

**加强 AI coding 的人在回路（human-in-the-loop）**：让人更方便、细致地 **审计** AI 产出，并把 **反馈** 交回 AI（终端里的 CLI）。

- 不是通用 IDE，不是全自动 agent 产品。  
- 读 / 双 commit diff / 选区批注 / 多标签终端 = **手段**。  
- 给 AI 的交接 v1 = **复制 session YAML 的执行端绝对路径**（不强制 brief 生成器、不内置 agent 编排 UI）。

---

## 2. 平台与执行模型

| UI 所在 | 代码 / git / shell / AI CLI |
|---------|------------------------------|
| macOS / Linux | 本机 |
| Windows | **WSL，经 SSH**（路径用 WSL 视角，不混 `\\wsl$\`） |

抽象名：**HostSession（模块 id: `host`）** — 执行环境门面（类比 PAL/HAL，不是业务模块）。

- Local：`spawn` + `fs` + `node-pty`  
- SSH：命令 / 文件 / PTY 都走对端  
- 业务 **只** 经 host，Renderer **禁止** 直连 PTY/SSH/`child_process`

**第一阶段先做 Local（Mac/Linux 可验收 HITL）**；SSH/WSL 放 DESIGN 切片 6。

---

## 3. UI 壳层（对齐参考图）

`docs/anchor-code/ui-reference.png`：

```text
顶栏: [Open Workspace]  [Search … ⌘K]  [Toggle Terminal]
左:   FILES | COMMENTS | HISTORY (GIT)   + 模式内容（文件树等）
中:   打开项 tabs + Markdown Rendered / 代码只读 / 之后 Diff
右:   TERMINAL 多标签（1:zsh, 2:node, +）
```

- 浅色、细线、flat；中央阅读优先。  
- **右侧是 Terminal**，不是 Code review / Agent 大面板。  
- **中央不要 repo 切换器**；多仓只在 HISTORY。  
- 不要求像素复制，但 **分区与控件角色必须对齐参考图**。

---

## 4. 模块命名（代码 / IPC 用这些 id）

| 模块 id | 职责 | 勿误解为 |
|---------|------|----------|
| `host` | Local/SSH：run / fs / pty | 业务规则 |
| `workspace` | 打开 folder、文件树、读文本 | 多仓列表 |
| `history` | 多 root、log、双选 compare | 裸 `git` 包一层（内部才 `run(git…)`） |
| `annotations` | session YAML、高亮投影、复制路径 | 随便叫 comments 模块即可 UI 文案仍用 Comments |
| `document` | 中央 open items、只读文件/Diff 展示 | 可写 editor |
| `terminal` | 多标签 PTY，cwd=工作区 | agent 协议 |
| `shell` | 布局 + **用例编排** | 上帝业务对象 |

**依赖纪律（防环）：**

- 特性模块 **不要互相 import** 对方 store/UI。  
- `history.runCompare` → **shell** → `document.openDiff`。  
- 批注 jump 同理经 shell。  
- `history` / `annotations` 对 workspace 只取 **root / 路径解析**，不绑文件树 UI。

IPC 示例命名：`history.*`、`annotations.*`，**不要** `git.*`。

---

## 5. 核心行为（实现验收锚点）

1. **打开工作区** = 选执行端上一个目录（类 VS Code folder）。  
2. **HISTORY**：发现 git root；勾选 commit——**先勾 = base，后勾 = head**（可 Swap）；两笔 → Compare；一笔 → Compare with worktree。中央开 Diff（Monaco DiffEditor）。  
3. **批注**：代码 + MD；选区高亮；悬停预览；左栏 COMMENTS 跳转；**同时刻每仓至多一个 active session**；落盘 `<repo>/.anchor-code/*.yaml`（YAML 唯一事实来源）。  
4. **复制 YAML 路径** 到剪贴板（执行端绝对路径，AI CLI 可读）。  
5. **Terminal**：右侧多标签；cwd = workspaceRoot。

Schema / 状态机 / Host API 草图 → 见 `DESIGN.md` §2、§6。

---

## 6. 技术栈（已定方向）

Electron + React + TypeScript + Vite  
react-resizable-panels · Monaco · react-markdown + remark-gfm · xterm.js + node-pty（SSH 用 ssh2 等）· zustand · zod + yaml  

---

## 7. 建议实现切片（严格按序优先）

```text
Slice 1  host Local + IPC 骨架 + shell 三栏（对齐 ui-reference，可 mock）
Slice 2  workspace 打开目录 + 文件树 + document 代码/MD 只读
Slice 3  history discover + log + 双选 Compare + document Diff
Slice 4  annotations YAML + 高亮 + 侧栏 + 复制路径
Slice 5  terminal 多标签 + cwd=工作区
Slice 6  host SSH + Windows→WSL
Slice 7  失锚 UX、session End/New、worktree/体验打磨
```

**你现在的第一刀 = Slice 1**，做完应能：

- `npm`/`pnpm` 起 Electron 窗  
- 三栏布局可辨认（对照参考图）  
- preload 暴露版本或空 `host` API  
- 尚不必真 git / 真 PTY（可占位）

---

## 8. 红线（实现中禁止无意违反）

1. 中央 **无** 全局 multi-repo 切换 chrome。  
2. 模块/IPC **不** 以裸 `git` 命名领域 API。  
3. `document` **不** 与 `history`/`annotations` 双向 import 成环。  
4. 批注 **只** 以 YAML 为真相源；给 AI = 复制执行端路径。  
5. v1 **不** 做：拓扑 graph 库、diff hunk 批注、完整编辑/调试、云协作、内置 agent 编排。  
6. Windows v1 **不** 承诺管理 Windows 原生路径仓库（只认 WSL 侧路径）。

---

## 9. 已知可延后默认（不必再问用户即可开工）

| 项 | 默认 |
|----|------|
| base/head | 先勾 base、后勾 head + Swap |
| worktree compare | 勾选恰好 1 笔时主按钮 |
| Session UI | 无 active 则自动创建；最小 End/New |
| 多 root 批注列表 | 跟当前 open item 所属仓 |
| MD 批注分期 | 可先代码 + MD Raw；Rendered 投影随后 |
| 顶栏 Search / Welcome | 占位即可 |
| 左栏底 branch 状态 | 占位或最小 `git` 查询 |
| author | 系统用户或 `local-user` |
| log 条数 / 扫描深度 | 常量（如 200 / depth 3） |

---

## 10. 目录建议（实现时）

```text
anchor-code/
  package.json
  electron/          # main, preload, host/
  src/
    app/
    core/            # history, annotations, workspace（纯逻辑）
    features/        # shell, files, history, annotations, document, terminal
  docs/anchor-code/  # 已有文档，勿删
```

---

## 11. 成功标准（整条 HITL，非 Slice 1）

在 Mac 或 Linux Local 上最终应能：

1. 打开工作区，细读代码与 MD；  
2. HISTORY 勾选两 commit 看 diff；  
3. 选区批注，高亮/侧栏/YAML 持久化；  
4. 复制 YAML 路径，在右侧终端交给 AI CLI；  
5. 气质为阅读审计台，非 IDE 驾驶舱。

Slice 1 只要求壳 + host 骨架可运行。

---

## 12. 交接检查清单（下一个 agent 开干前）

- [ ] 已打开并扫过 `ui-reference.png`  
- [ ] 已读 DESIGN §3（壳）、§4（模块/依赖）、§8（切片）  
- [ ] 确认工作区 `~/anchor-code` 从零建应用，不以 demo 为基线  
- [ ] 第一提交目标锁定 **Slice 1**  
- [ ] 不把「通用代码审阅 IDE」写进 README 首句；首句应是 **AI coding HITL**

---

*文档状态：DISCUSSION / PROPOSAL / DESIGN 已齐；UI 主参考已换新图。可以开工。*
