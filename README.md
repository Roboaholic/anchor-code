# Anchor Code

**Agent it. Review it. Feed it back.**

A **human-in-the-loop** reader for agent coding.

Use your AI coding CLI (Claude Code, Codex, and similar) in the terminal. Use Anchor Code to read the result carefully, review the diff, leave selection comments, and hand structured feedback back to the agent.

This is not a general-purpose IDE and not an agent orchestrator. Reading, dual-commit compare, annotations, and a multi-tab terminal exist to keep **you** in the loop.

## What you can do

| Area | Purpose |
|------|---------|
| **Files** | Open a workspace; browse and read code and Markdown |
| **History** | Pick two commits (or a commit vs worktree) and Compare |
| **Document** | Read-only code viewer, Markdown, and side-by-side diff |
| **Comments** | Select text, add annotations, store them in session YAML |
| **Terminal** | Multi-tab shell with cwd set to the workspace — run your agent CLI here |

Feedback is meant to go back to the agent: copy the session YAML path from Comments and paste it into the terminal for the CLI to read.

## Typical loop

1. **Open a workspace** — files, code, and docs in one place.
2. **Review the change** — in History, select commits and Compare (or compare with the worktree).
3. **Leave feedback** — open a file or diff, select text, add a comment (or use ⌘/Ctrl+M).
4. **Close the loop** — in Comments, **Copy path** (session YAML absolute path), paste it into the agent terminal, and ask the agent to apply the feedback.

Repeat until you are satisfied.

## Requirements

- Node.js 20+
- macOS or Linux for Local host (Windows WSL path is a later host mode)
- System `git` on PATH
- npm
- Native build tools for `node-pty` (e.g. Xcode CLT on macOS)

## Install and run

```bash
npm install
npm run rebuild:native   # if the terminal fails to start
npm run dev
```

Optional checks:

```bash
npm test                 # unit + integration
npm run test:unit
npm run test:integration # needs git
```

Deeper product design notes live under [`docs/anchor-code/`](docs/anchor-code/).

## License

Private / TBD.
