import type { RequestMessage } from '../../../types/llm/request'

import type { EditorSnapshotInjection, EditorSnapshotSelection } from './types'

const SCOPE_RULES = [
  "1. The text between <selected_text_start> and </selected_text_end> is the only target of the user's request.",
  '2. Do not translate, rewrite, summarize, or explain text outside the selected text unless the user explicitly asks for broader context.',
  '3. Use the surrounding text only to understand the selected text.',
  '4. Your output should correspond only to the selected text.',
  "5. If the user's request is ambiguous, assume it applies only to the selected text.",
].join('\n')

/**
 * Render Quick Ask's "editor snapshot": file path/title, surrounding cursor
 * context, and optional selection. Quick Ask deliberately injects content
 * (not just a pointer) because the user is acting on what they're editing.
 *
 * Returns null when there's nothing meaningful to inject.
 */
export function renderEditorSnapshotInjection(
  injection: EditorSnapshotInjection,
): RequestMessage | null {
  const trimmedTitle = injection.fileTitle.trim()
  const trimmedPath = injection.filePath.trim()
  const hasContext = injection.contextText.trim().length > 0
  const trimmedSelection = injection.selection?.content.trim() ?? ''
  const hasSelection =
    Boolean(injection.selection) && trimmedSelection.length > 0

  if (!trimmedTitle && !trimmedPath && !hasContext && !hasSelection) {
    return null
  }

  const body =
    hasSelection && hasContext && injection.selection
      ? buildSelectionScopedBody({
          fileTitle: trimmedTitle,
          filePath: trimmedPath,
          contextText: injection.contextText,
          cursorMarker: injection.cursorMarker,
          selection: injection.selection,
        })
      : buildPlainBody({
          fileTitle: trimmedTitle,
          filePath: trimmedPath,
          contextText: injection.contextText,
          cursorMarker: injection.cursorMarker,
        })

  return {
    role: 'user',
    content: body,
  }
}

function buildPlainBody({
  fileTitle,
  filePath,
  contextText,
  cursorMarker,
}: {
  fileTitle: string
  filePath: string
  contextText: string
  cursorMarker: string
}): string {
  const sections: string[] = [
    '# Editor Snapshot',
    'The user is asking a question in the context of their current document.',
  ]

  if (fileTitle) {
    sections.push(`File title: ${fileTitle}`)
  }
  if (filePath) {
    sections.push(`File path: ${filePath}`)
  }

  if (contextText.trim()) {
    sections.push(
      `Here is the text around the cursor (context). The marker ${cursorMarker} indicates the cursor position:`,
      `"""\n${contextText}\n"""`,
    )
  }

  sections.push(
    "Answer the user's question based on this context when relevant.",
  )

  return `${sections.join('\n')}\n\n`
}

function buildSelectionScopedBody({
  fileTitle,
  filePath,
  contextText,
  cursorMarker,
  selection,
}: {
  fileTitle: string
  filePath: string
  contextText: string
  cursorMarker: string
  selection: EditorSnapshotSelection
}): string {
  const wrappedSelection = `<selected_text_start>\n${selection.content}\n</selected_text_end>`

  // Replace the cursor marker (if present) with the wrapped selection so the
  // model sees the selection in-place inside its surrounding context. If the
  // selection content doesn't follow the marker exactly, fall back to
  // appending the wrapped selection after the context.
  let inlineContext: string
  const [before, ...afterParts] = contextText.split(cursorMarker)
  const after = afterParts.join(cursorMarker)
  if (afterParts.length > 0 && after.startsWith(selection.content)) {
    inlineContext = `${before}${wrappedSelection}${after.slice(selection.content.length)}`
  } else {
    inlineContext = `${contextText}\n\n${wrappedSelection}`
  }

  const sections: string[] = [
    '# Editor Snapshot',
    'You are answering a request about a user-selected passage.',
    '',
    'Scope rules:',
    SCOPE_RULES,
    '',
  ]

  if (fileTitle) {
    sections.push(`File title: ${fileTitle}`)
  }
  if (filePath) {
    sections.push(`File path: ${filePath}`)
  }

  sections.push(
    `<selection_context path="${selection.filePath}">`,
    inlineContext,
    '</selection_context>',
  )

  return `${sections.join('\n')}\n`
}
