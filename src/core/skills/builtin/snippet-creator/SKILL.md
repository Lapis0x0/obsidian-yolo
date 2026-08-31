---
name: snippet-creator
description: Guide for editing `YOLO/snippets.md`, the user's library of chat snippets (short prompts the user inserts via the chat input's `/` menu, e.g. `/translate`, `/review`). Use when the user asks to add, edit, rename, list, or delete a 快捷指令 / chat snippet, or describes a recurring prompt they want as a slash shortcut.
mode: lazy
---

# Snippet Creator

Snippets are **short prompt texts** users insert into the chat input by typing `/` and picking from the "快捷指令" category. Selecting one inserts the body verbatim — the user then edits or sends it.

## Format (`YOLO/snippets.md`)

```md
## trigger
> one-line description (optional)

The prompt text to insert.
```

## Rules

- `##` marks a snippet boundary. **Never use `##`, `###`, `####`… inside the body** — they will be parsed as separate snippets. Use bold or dashes for emphasis instead.
- The body is **what you ask the AI to do**, not the document you want the AI to produce.
  - ✅ `Draft a test report with sections: goal, scenarios, expected, actual.`
  - ❌ `## Goal\n## Scenarios\n## Expected\n## Actual\n…` ← document skeleton, not a prompt.
- Keep it short. If a structured ask is needed, describe the structure in prose.

## Workflow

Read `YOLO/snippets.md` and append a new `## trigger` block. Create the file with `fs_write` if missing.
