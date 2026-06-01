import {
  DEFAULT_YOLO_BASE_DIR,
  YOLO_SNIPPETS_FILE_NAME,
} from '../paths/yoloPaths'

export const YOLO_SNIPPETS_PATH = `${DEFAULT_YOLO_BASE_DIR}/${YOLO_SNIPPETS_FILE_NAME}`

export const getSnippetsPathAwareTemplate = (
  template: string,
  snippetsPath: string = YOLO_SNIPPETS_PATH,
): string => {
  return template.split(YOLO_SNIPPETS_PATH).join(snippetsPath)
}

/**
 * Default content for a freshly created `YOLO/snippets.md`.
 * Provides two ready-to-use examples plus a short format reminder.
 */
export const DEFAULT_SNIPPETS_TEMPLATE = `<!--
YOLO snippets: split by \`## trigger\`. Each block is a short prompt that gets inserted into the chat input.
Do not use \`##\` / \`###\` inside the body — they would be treated as new snippets.
-->

## translate
> Translate the selection into English

Please translate the following content into English while preserving the original tone:

## review
> Code review

Please review the code below, focusing on: edge cases, error handling, naming and readability.
`

export const YOLO_SNIPPET_CREATOR_TEMPLATE = `---
id: snippet-creator
name: Snippet Creator
description: Guide for editing \`YOLO/snippets.md\`, the user's library of chat snippets (short prompts the user inserts via the chat input's \`/\` menu, e.g. \`/translate\`, \`/review\`). Use when the user asks to add, edit, rename, list, or delete a 快捷指令 / chat snippet, or describes a recurring prompt they want as a slash shortcut.
---

# Snippet Creator

Snippets are **short prompt texts** users insert into the chat input by typing \`/\` and picking from the "快捷指令" category. Selecting one inserts the body verbatim — the user then edits or sends it.

## Format (\`YOLO/snippets.md\`)

\`\`\`md
## trigger
> one-line description (optional)

The prompt text to insert.
\`\`\`

## Rules

- \`##\` marks a snippet boundary. **Never use \`##\`, \`###\`, \`####\`… inside the body** — they will be parsed as separate snippets. Use bold or dashes for emphasis instead.
- The body is **what you ask the AI to do**, not the document you want the AI to produce.
  - ✅ \`Draft a test report with sections: goal, scenarios, expected, actual.\`
  - ❌ \`## Goal\\n## Scenarios\\n## Expected\\n## Actual\\n…\` ← document skeleton, not a prompt.
- Keep it short. If a structured ask is needed, describe the structure in prose.

## Workflow

Read \`YOLO/snippets.md\` and append a new \`## trigger\` block. Create the file with \`fs_write\` if missing.
`
