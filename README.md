# Anchor Code

**Human-in-the-loop workbench for AI coding** — audit model output carefully, leave selection annotations, and hand a session YAML path back to the AI CLI in the terminal.

Not a general-purpose IDE. Not an agent orchestration product. Read / dual-commit diff / annotations / multi-tab terminal are means on that loop.

## Status

**M4 (Slice 1–5) on Local host**

| Slice | Capability |
|-------|------------|
| 1 | Electron shell + host/IPC skeleton |
| 2 | Open workspace, file tree, Monaco + MD read-only |
| 3 | History: discover roots, log, dual-select Compare, DiffEditor |
| 4 | Annotations: session YAML, decorations, Comments pane, copy path |
| 5 | Multi-tab terminal (`node-pty` + xterm), cwd = workspace |

Next: Slice 6 SSH/WSL, Slice 7 polish (anchor UX, etc.).

Product docs: [`docs/anchor-code/`](docs/anchor-code/).

## Requirements

- Node.js 20+
- macOS or Linux for Local host
- System `git` on PATH
- npm
- Native build tools for `node-pty` (Xcode CLT on macOS)

## Develop

```bash
npm install
npm run rebuild:native   # if terminal fails to start
npm test                 # unit tests (vitest)
npm run dev
```

### Tests

```bash
npm test           # single run
npm run test:watch # watch mode
```

Unit tests cover pure domain logic under `src/core/` (history dual-select, diff name-status parse, annotation anchor relocation, session YAML schema / single-active rules, workspace path helpers).

### HITL smoke path

1. **Open Workspace** on a git repo (this project works).
2. **HISTORY** — select two commits → **Compare** (or one → **Compare with worktree**).
3. Open a source file, select text → **Add comment** (or ⌘/Ctrl+M) → save.
4. **COMMENTS** → **Copy path** (session YAML absolute path).
5. Paste the path into the **TERMINAL** for your AI CLI.

## Architecture (short)

| Module id | Role |
|-----------|------|
| `host` | Local/SSH run · fs · pty facade |
| `workspace` | Open folder, tree, read text |
| `history` | Multi-root discover, log, dual compare (never `git.*` IPC) |
| `annotations` | Session YAML, decorations, copy path |
| `document` | Center open items, read-only file / diff |
| `terminal` | Multi-tab PTY, cwd = workspace |
| `shell` | Layout + use-case orchestration |

Renderer never spawns PTY/SSH/`child_process` — only `window.anchor.*` via preload.

## License

Private / TBD.
