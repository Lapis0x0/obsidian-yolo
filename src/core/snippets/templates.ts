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
