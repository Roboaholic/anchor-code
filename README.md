# Anchor Code

**Agent it. Review it. Feed it back.**

A **human-in-the-loop** reader for agent coding.

Use your AI coding CLI (Claude Code, Codex, and similar) in the terminal. Use Anchor Code to read the result carefully, review the diff, leave selection comments, and hand structured feedback back to the agent.

This is not a general-purpose IDE and not an agent orchestrator. Reading, dual-commit compare, annotations, and a multi-tab terminal exist to keep **you** in the loop.

![Anchor Code — History compare and side-by-side diff](assets/screenshot.png)

## What you can do

| Area | Purpose |
|------|---------|
| **Files** | Open a workspace; browse and read code and Markdown |
| **History** | Pick two commits (or a commit vs worktree) and Compare |
| **Document** | Read-only code viewer, Markdown, and side-by-side diff |
| **Comments** | Select text, add annotations, store them in session YAML |
| **Terminal** | Multi-tab shell with cwd set to the workspace — run your agent CLI here |

Feedback is meant to go back to the agent: copy the session YAML path from Comments and paste it into the terminal for the CLI to read. Install the **Anchor Review** agent skill from **Settings → Agent skill** (or accept the prompt when opening a workspace) so agents know how to process `need_modify` comments and close them.

## Typical loop

1. **Open a workspace** — files, code, and docs in one place. If prompted, install the Anchor Review skill into `.agents/skills/`.
2. **Review the change** — in History, select commits and Compare (or compare with the worktree).
3. **Leave feedback** — open a file or diff, select text, add a comment (or use ⌘/Ctrl+M). Mark actionable items `need_modify`.
4. **Close the loop** — in Comments, **Copy path** (session YAML absolute path), paste it into the agent terminal, and ask the agent to apply the feedback.

Repeat until you are satisfied.

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

## Requirements

- Desktop: Windows, macOS, or Linux
- Host for the workspace:
  - **Local** — native paths on Windows / macOS / Linux
  - **WSL** — on Windows, open a distro path via the Open Workspace host picker
- System `git` on PATH on the chosen host

## Install and run

Download a build from [Releases](https://github.com/Roboaholic/anchor-code/releases):

| Platform | Installer | Portable / other |
|----------|-----------|------------------|
| Windows | `Anchor.Code-*-win-x64.exe` (NSIS setup) | `Anchor.Code-*-win-x64-portable.exe` |
| macOS | `Anchor.Code-*-mac-*.dmg` | `.zip` |
| Linux | `.AppImage` or `.deb` | — |

1. Install or run the downloaded package (unsigned builds may need an OS “Open anyway” / SmartScreen allow).
2. Open Anchor Code.
3. **Open Workspace** — pick Local or WSL, then choose a folder.
4. Use History / Comments / Terminal as in the loop above.

## License

[Apache License 2.0](LICENSE)
