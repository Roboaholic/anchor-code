
**Agent it. Review it. Feed it back.**

Anchor Code is a human-in-the-loop review workbench for AI-assisted coding. It sits beside Claude Code, Codex, and other terminal agents so people can inspect changes, ask precise questions, request modifications, and verify the next iteration.

The core idea is simple: **agent output is not the end of the workflow. Review, feedback, and verification are part of the workflow.**

## The review loop

```text
Agent changes code
        |
        v
Compare commits or worktree in the Diff Workbench
        |
        v
Select code, leave a comment, and set its review status
        |
        v
Send the session path back to the agent
        |
        v
Agent replies or modifies code
        |
        +----> review the new diff and close the thread
```

### Review comments that go somewhere

Comments are anchored to files, lines, and selections, then stored in a review session. Each thread has an explicit state:

- `discussing` for questions and clarification
- `need_modify` for actionable change requests
- `closed` when the issue is resolved or no further action is needed

The **Feedback** action exports the structured session context for the agent. The agent can read the session, reply in context, make changes, and leave the human with a clear status to close or continue. This creates a durable **review → comment → feedback → change → re-review** loop instead of a one-off chat message.

![Session comments and Feedback action](assets/review-session-feedback.png)

### A Diff Workbench for human review

History lets you choose two commits, or compare a commit with the current worktree. The side-by-side Diff Workbench keeps the changed-file list, old and new code, line context, and review comments in one place. Comments written in a diff retain machine-readable diff context, so the agent knows which branch, revisions, file, and line range the feedback refers to.

![Diff Workbench with anchored review comment](assets/review-diff-workbench.png)

The original product screenshot remains available here:

![Anchor Code — History compare and side-by-side diff](assets/screenshot.png)

## What Anchor Code is for

| Capability | Why it matters |
|---|---|
| **History and worktree compare** | Review committed changes, uncommitted changes, or a selected commit range |
| **Side-by-side diff** | Read what changed in context without leaving the workspace |
| **Anchored comments** | Attach a question or request to the exact file and selection |
| **Review states** | Make discussion, modification requests, and closure visible |
| **Session-based feedback** | Give the agent structured, durable context it can consume |
| **Agent terminal** | Run the coding CLI beside the review surface |
| **Local and WSL workspaces** | Review code where it actually lives |

## How it compares

Anchor Code is deliberately focused on the human review stage of agent coding. It complements tools that edit code, launch agents, or host terminals.

| | Anchor Code | Zed | VS Code | Warp |
|---|---|---|---|---|
| Primary role | Human review workbench for agent changes | Fast, collaborative code editor | Extensible general-purpose editor | AI-native terminal |
| Diff review | Commit/worktree selection with a dedicated review surface | Git diff and editor workflows | Git/SCM views and extensions | Terminal and command output context |
| Anchored review comments | First-class selection comments with session state | Available through editor/collaboration features | Available through extensions, SCM, or code review integrations | Conversation-oriented terminal interaction |
| Feedback handoff | Session YAML and Feedback action designed for agent consumption | Depends on workflow or integration | Depends on extension and agent setup | Primarily through terminal context |
| Best fit | Inspecting, questioning, directing, and verifying agent edits | Editing and collaborative development | Building and customizing a full IDE workflow | Running commands and working with terminal agents |

Anchor Code does not try to replace these tools. Use your preferred editor or agent, then bring the result into Anchor Code when the change needs careful human review and an auditable feedback loop.


## Android companion (development preview)

The repository now includes `mobile/`, an Android companion that connects back
to the Anchor Code desktop app. It supports mobile review of code/Markdown,
worktree diffs, structured comments, comment status/replies, and remote Agent
CLI sessions. See [mobile/README.md](mobile/README.md) for build, security,
encrypted Relay access, emulator, and tablet verification instructions.

PC and companion development are separated by a versioned Remote API and a
shared PC application-facade layer. See [ARCHITECTURE.md](ARCHITECTURE.md) for
module ownership, dependency rules, and compatibility policy.

The mobile app connects only through the end-to-end encrypted Cloudflare Relay.
The PC opens an outbound WSS connection, so users do not expose a port or enter
an IP address/token in the App. See
[REMOTE_CONNECTIVITY_PLAN.md](REMOTE_CONNECTIVITY_PLAN.md) for the security
model, deployment status, and acceptance criteria.


## Install and run

Download a build from [Releases](https://github.com/Roboaholic/anchor-code/releases):

| Platform | Installer | Portable / other |
|---|---|---|
| Windows | `Anchor.Code-*-win-x64.exe` (NSIS setup) | `Anchor.Code-*-win-x64-portable.exe` |
| macOS | `Anchor.Code-*-mac-*.dmg` | `.zip` |
| Linux | `.AppImage` or `.deb` | — |

1. Install or run the downloaded package.
2. Open Anchor Code and choose **Local** or **WSL**.
3. Open the repository that your coding agent is changing.
4. In **History**, choose the commits or worktree to compare.
5. Select code, add comments, mark actionable feedback as `need_modify`, and use **Feedback** to send the session path to the agent.
6. Re-review the next diff and close resolved threads.

Install the **Anchor Review** agent skill from **Settings → Agent skill**, or accept the prompt when opening a workspace. It teaches compatible agents how to process `need_modify` comments and close review threads.

## Requirements

- Windows, macOS, or Linux desktop
- System `git` on PATH on the selected host
- WSL support when opening a WSL workspace on Windows

## License

[Apache License 2.0](LICENSE)
