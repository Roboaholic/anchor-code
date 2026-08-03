# Anchor Code

**Agent 编程流程中的 Human-in-the-loop Reviewer。**

**让 Agent 执行，让人 Review，让反馈回到 Agent。**

Anchor Code 将代码库、技术文档、文件管理、Git History、Diff、Review Comment 和 Agent CLI 集中到同一个界面。Agent 继续在原生终端环境中工作，人负责检查上下文、指导修改、反馈问题，并决定结果是否可以交付。

[English](README.md) · [下载 Anchor Code](https://github.com/Roboaholic/anchor-code/releases)

![集成文件、文档、Git History、Review Comment 和 Agent Terminal 的 Anchor Code 工作区](assets/screenshot.png)

## 让 Agent 保持速度，让人始终掌握方向

Agent 编程显著提高了实现速度，围绕它的人工工作流依然分散：代码在编辑器里，方案在 Markdown 里，改动在 Git 里，反馈留在聊天中，Agent 则运行在终端里。

Anchor Code 将这些界面重新连接起来。浏览代码库与技术文档、运行熟悉的 Agent、检查真实改动、针对准确位置展开讨论、发送结构化反馈，并由人决定结果何时可以交付。

| 代码与文档阅读 | Agent CLI | Git 与 Diff | Comment 与 Feedback |
|---|---|---|---|
| 浏览文件、搜索代码，阅读源代码、Markdown 和 Mermaid 技术文档。 | 在当前项目中运行原生 Agent CLI/TUI，并选择模型和推理配置。 | 查看 Commit History、分支与 Worktree 状态，通过 Side-by-side 或 Inline Diff 检查完整改动。 | 评论准确的代码选区，将 Review Session 交给 Agent，并在原线程中验证回复和修改。 |

## 为审查而设计的 Git History

选择任意两个 Commit，或将某个 Commit 与当前 Worktree 对比。Anchor Code 在一个专注的工作台中展示完整变更文件集合与 Diff，并支持 Side-by-side 和 Inline 两种阅读方式。

分支状态、版本、文件、源码行和 Comment 始终处于同一个上下文。写在 Diff 上的 Comment 会保留 branch、base、head、file 和 line range，为人和 Agent 提供准确引用。

![包含变更文件和锚点 Review Comment 的 Side-by-side Diff 工作台](assets/review-diff-workbench.png)

## 反馈交给 Agent，处理结果回到原线程

Comment 可以锚定到源代码或渲染后 Markdown 的准确选区。Review Session 使用 `discussing` 表示讨论，使用 `need_modify` 表示明确修改要求，使用 `closed` 表示问题已经解决。

点击 **Feedback** 即可将结构化 Session 交给选定的 Agent。Agent 可以在原线程回复、执行修改并更新状态。下一轮 Diff 和完整讨论记录继续保留，供人检查和验收。

![包含线程 Comment、状态跟踪和 Agent Feedback 的 Review Session](assets/review-session-feedback.png)

## 为什么选择 Anchor Code

Zed 和 VS Code 以代码编辑体验为中心，Warp 以终端和 Agent 体验为中心。Anchor Code 将文件、文档、Git 审查、Review 上下文和 Agent CLI 连接成连续的 Human-in-the-loop 工作流。

`✅` 内置支持 · `△` 需要组合其他工作流、集成或扩展 · `❌` 缺少对应工作流

| 能力 | Anchor Code | Zed | VS Code | Warp |
|---|---|---|---|---|
| 文件、代码与 Markdown | ✅ 内置 | ✅ 内置 | ✅ 内置 | △ 以终端为主 |
| 集成终端与 Agent CLI | ✅ 原生 CLI/TUI | ✅ 集成终端 | ✅ 集成终端 | ✅ 核心体验 |
| Git Commit History | ✅ 面向 Review 的 History | ✅ 项目/文件 History | ✅ Source Control Graph | △ CLI 与集成 |
| Commit ↔ Commit / Worktree 对比 | ✅ 一等 Diff 工作台 | △ Commit 与文件 Diff | △ 原生 Git 视图；GitLens 提供深度比较 | △ 主要通过 CLI |
| 锚定到代码与 Diff 的 Comment | ✅ Review Session | △ 编辑器/协作工作流 | △ 扩展或 PR 集成 | ❌ |
| 返回 CLI Agent 的结构化反馈 | ✅ 有状态 Feedback 闭环 | △ Agent/编辑器上下文 | △ 取决于 Agent 扩展 | △ 终端对话 |

真正的差异体现在 Diff 周围的完整流程。Anchor Code 将范围比较、代码锚点讨论、Agent 交接和人工验收组成一条原生主路径。

对比资料来源：[Zed Git](https://zed.dev/docs/git)、[VS Code Source Control](https://code.visualstudio.com/docs/sourcecontrol/overview)、[GitLens 功能](https://help.gitkraken.com/gitlens/gitlens-features/) 和 [Warp 文档](https://docs.warp.dev/)。

## 离开电脑，也能继续参与工作流

**Anchor Mobile** 将同一工作区扩展到 Android 手机和平板。你可以远程 Review 代码和 Markdown、检查 Worktree Diff、管理 Comment，并操作运行在 PC 上的 Agent Terminal Session。

扫描二维码即可通过端到端加密的 Anchor Relay 完成配对。文件、Git 操作、Shell 和 Agent 继续运行在 PC 上，Relay 负责转发加密帧。设置与 APK 说明见 [Anchor Mobile](mobile/README.md)，部署说明见 [Anchor Relay](relay/cloudflare/README.md)。

## 支持的 Agent 与环境

**Agent CLI：** Claude Code、Codex、Gemini CLI、Aider、Grok、OMP、Cursor Agent 和自定义 Profile。

**工作区：** Local、WSL 和 SSH。

**桌面系统：** Windows、macOS 和 Linux。

**移动端：** Android 手机和平板。

## 快速开始

1. 从 [Releases](https://github.com/Roboaholic/anchor-code/releases) 下载 Anchor Code。
2. 打开 Local、WSL 或 SSH 工作区。
3. 在内置 Terminal 中启动 Agent CLI，或打开已有改动的代码仓库。
4. 阅读代码和技术文档，然后在 **History** 中检查 Commit 或 Worktree。
5. 针对准确选区添加 Comment，将明确修改要求标记为 `need_modify`。
6. 点击 **Feedback** 将 Session 交给 Agent，再检查下一轮 Diff 并关闭已解决线程。

从 **Settings → Agent skill** 安装 **Anchor Review** Skill，也可以接受打开工作区时的安装提示。它会指导兼容 Agent 读取 Anchor Code Session、处理 `need_modify` Comment、回复线程并更新 Review 状态。

## 下载

| 平台 | 安装包 | Portable / 其他 |
|---|---|---|
| Windows | `Anchor.Code-*-win-x64.exe`（NSIS 安装包） | `Anchor.Code-*-win-x64-portable.exe` |
| macOS | `Anchor.Code-*-mac-*.dmg` | `.zip` |
| Linux | `.AppImage` 或 `.deb` | - |

Anchor Code 要求所选 Host 的 PATH 中可以使用 `git`。WSL 与 SSH 工作区需要对应 Host 环境和连接可用。

## License

[Apache License 2.0](LICENSE)
