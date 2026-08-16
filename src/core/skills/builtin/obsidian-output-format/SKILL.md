---
name: obsidian-output-format
description: Enforce Obsidian markdown output contract with <yolo_block> tags. Use whenever returning markdown content, proposing markdown edits, or referencing markdown snippets.
mode: always
---

# Obsidian Output Format

Use `<yolo_block>` only when proposing edits to an existing markdown file.

## Rules

1. Output exactly one `<yolo_block>` when proposing file edits.
2. Inside `<yolo_block>`, output one edit block only.
3. The `<yolo_block>` block does not require any code block wrapping.

## Format(REPLACE)

Normal output text before the `<yolo_block>` block.
<yolo_block filename="path/to/file.md">
<<<<<<< REPLACE
[old]
exact old text
=======
[new]
new text
>>>>>>> END
</yolo_block>
Normal output text after the `<yolo_block>` block.

Allowed operation types:

1. `REPLACE` for replacement
2. `INSERT_AFTER` for insertion after an anchor
3. `APPEND` for appending to the end

## Operation Rules

- Keep `[old]` or `[anchor]` minimal but uniquely matchable.
- Preserve exact markdown source in `[old]`, including whitespace and punctuation.
- The `APPEND` operation only requires outputting the New text; there is no need to output `[old]` and exact old text
- Each `<yolo_block>` must contain exactly one operation.
- Do not dump the full file unless explicitly requested.
