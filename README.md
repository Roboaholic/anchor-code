# Anchor Code

**Human-in-the-loop workbench for AI coding** — audit model output carefully, leave selection annotations, and hand a session YAML path back to the AI CLI in the terminal.

Not a general-purpose IDE. Not an agent orchestration product. Read / dual-commit diff / annotations / multi-tab terminal are means on that loop.

## Status

**Slice 2** — Open workspace, lazy file tree, read-only Monaco code + Markdown (Rendered/Raw).  
Done: Slice 1 shell + Local host IPC. Next: History dual-commit compare (Slice 3).

Product docs: [`docs/anchor-code/`](docs/anchor-code/) (`HANDOFF.md`, `DESIGN.md`, `PROPOSAL.md`, `ui-reference.png`).

## Requirements

- Node.js 20+ (tested with 25)
- macOS or Linux for Local host (Windows → WSL via SSH is a later slice)
- npm

## Develop

```bash
npm install
npm run dev
```

This starts Vite and opens the Electron window. You should see:

- **Open Workspace** — pick a folder; left FILES tree loads (lazy expand)
- Click a file — center opens read-only Monaco; `.md` defaults to Rendered (toggle Raw)
- Top bar search is still a placeholder; **Toggle Terminal** works (PTY in Slice 5)
- Version label from `window.anchor.shell.getVersion()`

```bash
npm run typecheck
npm run build
```

## Architecture (short)

| Module id   | Role                                              |
|-------------|---------------------------------------------------|
| `host`      | Local/SSH run · fs · pty facade                   |
| `workspace` | Open folder, tree, read text                      |
| `history`   | Multi-root discover, log, dual compare (not `git.*` IPC) |
| `annotations` | Session YAML, decorations, copy path            |
| `document`  | Center open items, read-only file / diff          |
| `terminal`  | Multi-tab PTY, cwd = workspace                    |
| `shell`     | Layout + use-case orchestration                   |

Renderer never spawns PTY/SSH/`child_process` — only `window.anchor.*` via preload.

## License

Private / TBD.
