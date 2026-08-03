# Anchor Code

**让 Agent 编码，让人 Review，让反馈回到 Agent。**

Anchor Code 是面向 AI 辅助编程的人机协作 Review 工作台。它与 Claude Code、Codex 以及其他终端 Agent 配合使用：人可以检查改动、针对具体代码提问、提出修改要求，并验证下一轮结果。

核心理念很明确：**Agent 产出代码不是流程终点，Review、反馈和验证都属于编码流程的一部分。**

## Review 闭环

```text
Agent 修改代码
       |
       v
在 Diff 工作台比较 Commit 或当前 Worktree
       |
       v
选中代码、发表评论并设置 Review 状态
       |
       v
把 Session 路径反馈给 Agent
       |
       v
Agent 回复或修改代码
       |
       +----> 重新检查 Diff，并关闭已解决的讨论
```

### 让 Comment 真正回到 Agent

Comment 会锚定到文件、行号和选区，并保存到 Review Session 中。每条线程都有明确状态：

- `discussing`：讨论和解释
- `need_modify`：需要 Agent 执行的修改
- `closed`：问题已解决，或无需继续处理

点击 **Feedback** 后，可以把结构化的 Session 上下文交给 Agent。Agent 读取 Session，基于原位置回复或修改代码；人再根据新的 Diff 验证结果，并关闭或继续讨论。这样形成可追踪的 **Review → Comment → Feedback → 修改 → Re-review** 闭环，不会让反馈停留在一次性的聊天消息里。

![Session 评论与 Feedback 操作](assets/review-session-feedback.png)

### 面向人类 Review 的 Diff 工作台

History 支持选择两个 Commit，也支持将 Commit 与当前 Worktree 比较。Side-by-side Diff 工作台把变更文件列表、新旧代码、行上下文和 Review Comment 放在同一个界面中。写在 Diff 上的 Comment 会保留可供 Agent 读取的 Diff 上下文，包括分支、版本、文件和行范围，让反馈始终对应准确的位置。

![带有锚点评论的 Diff 工作台](assets/review-diff-workbench.png)

原有的产品截图继续保留：

![Anchor Code — History 对比与并排 Diff](assets/screenshot.png)

## Anchor Code 提供什么

| 能力 | 价值 |
|---|---|
| **History 与 Worktree 对比** | 检查已提交改动、未提交改动或指定 Commit 范围 |
| **Side-by-side Diff** | 在工作区内阅读带上下文的代码变化 |
| **锚点 Comment** | 将问题或修改要求绑定到准确的文件和代码选区 |
| **Review 状态** | 清晰区分讨论、需要修改和已关闭 |
| **Session Feedback** | 为 Agent 提供结构化、持久的上下文 |
| **Agent Terminal** | 在 Review 界面旁运行编码 CLI |
| **Local 与 WSL 工作区** | 在代码实际所在的环境中完成 Review |

## 与 Zed、VS Code、Warp 对比

Anchor Code 专注于 Agent 编码流程中的人工 Review 阶段，与负责编辑代码、运行 Agent 或承载终端的工具互补。

| | Anchor Code | Zed | VS Code | Warp |
|---|---|---|---|---|
| 核心定位 | 面向 Agent 改动的人类 Review 工作台 | 高性能、协作型代码编辑器 | 可扩展的通用代码编辑器 | AI 原生终端 |
| Diff Review | 选择 Commit/Worktree，并提供专门的 Review 界面 | Git Diff 与编辑器工作流 | Git/SCM 视图及扩展 | 终端与命令输出上下文 |
| 锚点 Review Comment | 一等能力，支持选区 Comment 和 Session 状态 | 依赖编辑器或协作功能 | 依赖扩展、SCM 或代码 Review 集成 | 以终端对话为主 |
| Feedback 交接 | Session YAML 与 Feedback 操作，面向 Agent 消费设计 | 依赖具体工作流或集成 | 依赖扩展和 Agent 配置 | 主要通过终端上下文传递 |
| 最适合 | 检查、提问、指导和验证 Agent 改动 | 编码编辑与协作开发 | 构建可定制的完整 IDE 工作流 | 执行命令和使用终端 Agent |

Anchor Code 不试图替代这些工具。你可以继续使用熟悉的编辑器或 Agent；当改动需要认真检查、明确反馈和可追踪闭环时，把仓库打开到 Anchor Code 中完成 Review。

## 安装与运行

从 [Releases](https://github.com/Roboaholic/anchor-code/releases) 下载：

| 平台 | 安装包 | Portable / 其他 |
|---|---|---|
| Windows | `Anchor.Code-*-win-x64.exe`（NSIS 安装包） | `Anchor.Code-*-win-x64-portable.exe` |
| macOS | `Anchor.Code-*-mac-*.dmg` | `.zip` |
| Linux | `.AppImage` 或 `.deb` | — |

1. 安装或运行下载的程序。
2. 打开 Anchor Code，选择 **Local** 或 **WSL**。
3. 打开 Agent 正在修改的代码仓库。
4. 在 **History** 中选择要比较的 Commit 或 Worktree。
5. 选中代码、添加 Comment，将需要执行的反馈标记为 `need_modify`，然后点击 **Feedback** 把 Session 路径交给 Agent。
6. 检查下一轮 Diff，关闭已经解决的线程。

从 **Settings → Agent skill** 安装 **Anchor Review** Agent skill；打开工作区时也可以接受安装提示。该 skill 会帮助兼容的 Agent 处理 `need_modify` Comment，并关闭 Review 线程。

## 环境要求

- Windows、macOS 或 Linux 桌面系统
- 所选 Host 的 PATH 中可用 `git`
- 在 Windows 上打开 WSL 工作区时需要可用的 WSL 环境

## License

[Apache License 2.0](LICENSE)
