---
name: anchor-review
description: "Use when applying Anchor Code review feedback: reading .anchor-code session YAML paths the user pastes, processing selection comments, handling discussing/need_modify/closed statuses, consuming .anchor-code/exports JSON, or closing the human→agent feedback loop."
---

# Anchor Review (Anchor Code)

Anchor Code stores human review feedback as **session YAML** under the repo:

```text
<repo>/.anchor-code/<session-id>.yaml
<repo>/.anchor-code/exports/<session-id>.json   # optional export for AI backends
```

There is no separate `anch-review` CLI in Anchor Code. The product handoff is:

1. Human selects code/docs, leaves comments, sets status in the Comments pane.
2. Human copies the **session YAML absolute path** (or an export JSON path).
3. Human pastes that path into the agent terminal and asks you to apply the feedback.
4. You read the file, implement actionable items, and mark them closed.

## When to use this skill

Use this skill when the user:

- pastes a path under `.anchor-code/`
- asks to apply review comments / feedback / annotations from Anchor Code
- mentions session YAML, export JSON, `need_modify`, or “feed it back to the agent”
- asks how Anchor Code review statuses work

## Session YAML shape (source of truth)

```yaml
version: 1
id: session_...
title: Review ...
status: active            # session: active | closed
author: local-user
comments:
  - id: comment_...
    status: need_modify   # comment: discussing | need_modify | closed
    target:
      file_path: src/app.ts   # relative to repo root
      kind: source            # source | markdown
      start_line: 10
      end_line: 12
      start_column: 0
      end_column: 8
      selected_text: "..."
      before_context: "..."
      after_context: "..."
      line_text: "..."        # optional; helps relocate anchors
    messages:
      - id: message_...
        author: local-user
        created_at: ...
        body: "what to change"
```

Notes:

- **One active session** is normal; closed sessions stay on disk for history.
- Each comment is one anchored thread. `messages` is a linear conversation.
- Anchors are best-effort: prefer `selected_text` / `line_text` + nearby context if line numbers drifted.

## Export JSON (optional)

If the user gives `.anchor-code/exports/<session-id>.json`, do **not** invent a re-export step. Read it directly.

- Flattened `entries[]` (one row per message).
- `reviewStatus` uses export spelling: `discussing` | `needs_modify` | `closed`
  (YAML on disk uses `need_modify`; both mean the same workflow state).
- `threadId` maps to the YAML comment id.
- `relativePath` + line/column + `selectedText` are the anchor.

## Review statuses — agent behavior

| Status (YAML) | Export spelling | Meaning | Agent must |
|---------------|-----------------|---------|------------|
| `discussing` | `discussing` | Clarifying; not yet a confirmed action item | Read it. Only change code if the message body is clearly a concrete request; otherwise answer in chat or append a clarifying reply in YAML if asked. |
| `need_modify` | `needs_modify` | Confirmed change request | **Implement the change.** Treat as actionable work, not a discussion marker. |
| `closed` | `closed` | Done or intentionally concluded | **Skip.** Do not reopen unless the user explicitly asks. |

Recommended human workflow (for context):

- start at `discussing`
- switch to `need_modify` when a concrete change is agreed
- switch to `closed` when the issue is finished

### After you finish a `need_modify` item

1. Implement the code/doc change at the anchored location.
2. Update that comment in the **session YAML**:
   - set `status: closed`
   - bump `updated_at` to now (ISO-8601)
   - optionally append a short `messages[]` entry describing what you did
   - set `messages[].author` to the **Author identity** string from the handoff
     prompt when provided; otherwise use your real agent/CLI display name
     (never invent a different product name)
3. Do **not** leave a completed fix in `need_modify`.
4. Prefer a short summary in the terminal for the human: which comment ids you closed, which files you changed.

If the YAML path is read-only or the user only gave export JSON, still implement the fixes, list remaining open items, and tell the human to mark them `closed` in Anchor Code Comments.

## Reply language

- Match the language of each human comment thread when replying in chat or
  appending `messages[]` in the session YAML (Chinese comments → Chinese replies).
- If a thread mixes languages, follow the latest human message.
- Keep code identifiers, paths, and CLI/tool output as-is.

## Operating procedure

When handed a session path:

1. Read the YAML (or export JSON) fully enough to list open items.
2. Build a work queue: all `need_modify` / `needs_modify` first; include `discussing` only when clearly actionable or the user asked to process everything.
3. For each actionable comment:
   - open `target.file_path`
   - relocate with `selected_text` / `line_text` / context if lines shifted
   - apply the smallest correct change that satisfies the latest message body
   - verify (tests, typecheck, or a focused smoke run appropriate to the repo)
4. Close completed items in YAML as above.
5. Report: closed ids, remaining open ids, files touched, any blocked items.

### Diff-context comments

Some message bodies start with `[diff context]` and include branch / base / head / file. Use that as review context (which side of a compare the human was looking at). Still edit the real worktree file unless the user asks for something else.

## What not to do

- Do not invent a `anch-review` CLI for Anchor Code.
- Do not require re-export when the user already gave a file path under `.anchor-code/exports/`.
- Do not ignore `need_modify` items.
- Do not treat every `discussing` thread as a mandatory code change.
- Do not rewrite unrelated code “while you are here.”
- Do not write absolute machine-specific paths into this skill or into session files.

## Install locations (reference)

Agents discover this skill from common skill roots, for example:

- workspace: `<workspace>/.agents/skills/anchor-review/SKILL.md`
- user: `~/.codex/skills/anchor-review/SKILL.md`
- user: `~/.claude/skills/anchor-review/SKILL.md`
- user: `~/.agents/skills/anchor-review/SKILL.md`
- user: `~/.grok/skills/anchor-review/SKILL.md`

Anchor Code can install/copy this file from **Settings → Agent skill**, or prompt on **Open Workspace**.
