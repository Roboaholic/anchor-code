# Anchor Code

**Human-in-the-loop workbench for AI coding** — audit model output carefully, leave selection annotations, and hand a session YAML path back to the AI CLI in the terminal.

Not a general-purpose IDE. Not an agent orchestration product. Read / dual-commit diff / annotations / multi-tab terminal are means on that loop.

## Status

**Slice 1** — Electron shell + Local host / IPC skeleton. Later slices: workspace reading, History compare, annotations, real PTY, SSH/WSL.

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

- Top bar: Open Workspace (placeholder), search placeholder, **Toggle Terminal**
- Left: FILES / COMMENTS / HISTORY (GIT) modes
- Center: Welcome tab
- Right: TERMINAL mock tabs (real PTY in Slice 5)
- Version label in the top bar from `window.anchor.shell.getVersion()`

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
