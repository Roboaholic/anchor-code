# Anchor Code

[English](README.md) · **中文**

**面向 Agent 编程的人在回路（human-in-the-loop）审阅工具。**
**Agent it. Review it. Feed it back.**

Anchor Code 把代码、技术文档、Git 历史、Diff、审阅评论和你在用的 Agent CLI 放进同一个桌面应用。Agent 继续在原生终端里工作，你在这里阅读上下文、针对具体行讨论、发送结构化反馈，并决定结果是否可以交付。

**[下载最新版本 →](https://github.com/Roboaholic/anchor-code/releases/latest)**（Windows · macOS · Linux）

![Anchor Code：文件树、带审阅高亮的源码，以及侧栏中的 Agent 会话](docs/images/hero.png)

## 功能

每次循环都一样：Agent 写代码，你对着具体行看，标出还要改的地方，再点 **Feedback** 把这次审阅交回去。下面的截图是界面，动图是操作过程。

### 锚定到具体行的评论

选中代码或渲染后的 Markdown，在钉住选区的行内气泡里写评论。每条线程是问题（`discussing`）、修改请求（`need_modify`）或已解决（`closed`）。

审阅会话把这些线程和文件放在一起。Agent 在原线程里回复，也可以改状态，不会另开一段对话。

![带行锚定评论和 Pi Agent 回复的审阅会话](docs/images/comments.png)

写评论时选区还在。边写边选状态，然后添加。

![选中代码行，在评论气泡中撰写审阅意见并添加](docs/images/comment-bubble.gif)

**Feedback** 把整个会话交给 Agent。回复回到原线程，并带上改了哪些文件、哪些线程还开着。

![通过 Feedback 把审阅会话交给 Pi，Pi 的回复出现在评论线程中](docs/images/feedback-reply.gif)

### 工作区 Diff

在 **History → Changes** 里打开任意改动文件，即可并排或行内查看未提交的 Diff，并附带行内 blame。

![未提交改动的并排 Diff](docs/images/diff.png)

### 为审阅设计的 Git 历史

任选两个提交，或一个提交与当前工作区，点击 **Compare** 就能在一个 Diff 工作台里看到完整的改动文件列表。在 Diff 中创建的评论会保留分支、base、head、文件和行范围上下文。

![History：选中两个提交并对比，显示改动文件列表](docs/images/history.png)

### Agent CLI 会话

Agent 仍跑在自己的终端里。Anchor Code 把它放进侧栏，或全宽的 **Agent** 工作台，审阅和 CLI 共用一个窗口。

![运行中的 Agent 会话（Agent 工作台）](docs/images/agent.png)

从选择器新建会话（Claude Code、Codex、Gemini CLI、Grok、OMP、Pi 等），或恢复 CLI 里已有的会话。CLI 支持时，可以选择模型和推理强度。

![新建 Agent 会话对话框：已选择 Pi，显示其 DeepSeek 模型和可恢复的 Pi 会话](docs/images/agent-picker.png)

多个会话可以同时跑。面板里的列表用来切换，每个会话保留自己的终端。

![Agent 面板中的三个 Pi 会话，其中一个刚编写并运行了新测试](docs/images/agent-sessions.png)

会话就是那个 CLI。下面是新建一个 Pi 会话、改代码并跑测试，不用离开工作台。

![新建 Pi 会话，修改代码并运行测试](docs/images/agent-working.gif)

### 针对选区提问（Ask）

想要一个答案、而不是一条审阅线程时，选中几行后点 **?**。问题出现在钉住选区的小气泡里，可以发给空闲会话，也可以新建。**Read-only** 默认勾选，新建的 Agent 会以 plan / 只读模式启动。按 `Ctrl+Enter` 发送。

![锚定在选中行下方的 Ask 气泡](docs/images/ask.png)

回答回到 Agent 面板，仍然对着你选中的那几行。

![选中代码向 Pi 提问，答案出现在 Agent 面板中](docs/images/ask-answer.gif)

### Markdown 与 Mermaid

技术文档原地渲染，包括 Mermaid 图。渲染后的文字也能像代码一样评论。

![渲染后的设计文档与 Mermaid 流程图](docs/images/markdown.png)

### 搜索与快速打开

内容搜索会在 ripgrep 找到结果时流式显示。搜索和快速打开都遵守 `.anchorignore` 和每个工作区的排除规则。

![侧栏中的内容搜索结果](docs/images/search.png)

`Ctrl+P` 是文件选择器：对路径做模糊匹配，然后打开。

![Ctrl+P 快速打开与模糊匹配](docs/images/quick-open.png)

## 工作区

| 工作区 | 文件、Git 与 Agent 运行位置 | 说明 |
|---|---|---|
| **Local** | 本机 | 文件树通过系统文件监听自动刷新。 |
| **WSL**（Windows） | WSL 发行版内 | 在 WSL 内使用辅助进程加速搜索和 Git。 |
| **SSH** | 通过 SSH 连接的远程主机 | 远程主机需要安装 `git`。 |

Anchor Code 启动时会重新打开上次的工作区（可在 **Settings → Appearance → Startup** 关闭）；如果它不可用，就停留在欢迎页。

**支持的 Agent CLI：** Claude Code、Codex、Gemini CLI、Grok、OMP、Pi、Aider、Goose、Cursor Agent，以及自定义配置。

## 安装

从 [Releases](https://github.com/Roboaholic/anchor-code/releases/latest) 下载：

| 平台 | 文件 |
|---|---|
| Windows（x64） | `Anchor.Code-<version>-win-x64.exe`（安装版）或 `Anchor.Code-<version>-win-x64-portable.exe`（便携版） |
| macOS（Apple 芯片） | `Anchor.Code-<version>-mac-arm64.zip` |
| Linux（x64） | `Anchor.Code-<version>-linux-x86_64.AppImage` 或 `Anchor.Code-<version>-linux-amd64.deb` |

要求：所打开的主机（本机、WSL 或 SSH）上装有 `git`，以及你想使用的 Agent CLI。更新通过 GitHub Releases 检查（**Settings → Updates**）。

## 快速上手

1. 安装并启动 Anchor Code，点击 **Open Workspace**（Local、WSL 或 SSH）。
2. 用 **New agent session** 启动 Agent，或打开一个已有改动的仓库。
3. 阅读代码和文档；用 **History** 查看工作区改动或对比提交。
4. 选中代码行添加评论，需要修改的标为 `need_modify`。
5. 点击 **Feedback** 把会话交给 Agent，然后审阅下一版 Diff，关闭已解决的线程。

在 **Settings → Agent skill** 安装 **Anchor Review** 技能（或接受工作区里的提示）。它教会兼容的 Agent 读取 Anchor Code 会话、处理 `need_modify` 评论、在线程中回复并更新状态。

## 从源码构建

需要 Node.js 22 和 Git。

```bash
git clone https://github.com/Roboaholic/anchor-code.git
cd anchor-code
npm ci            # 同时准备 node-pty 和内置的 ripgrep
npm run dev       # 以热更新方式运行

npm run typecheck && npm run lint && npm test

npm run pack:linux   # 或 pack:win / pack:mac，安装包输出到 release/
```

## 许可证

[Apache License 2.0](LICENSE)
