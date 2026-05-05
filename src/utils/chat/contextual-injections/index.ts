import type { ContentPart, RequestMessage } from '../../../types/llm/request'

import {
  type CurrentFilePointerRenderContext,
  renderCurrentFilePointerInjection,
} from './currentFilePointerContext'
import { renderEditorSnapshotInjection } from './editorSnapshotContext'
import type { ContextualInjection } from './types'

export type {
  ContextualInjection,
  CurrentFilePointerInjection,
  EditorSnapshotInjection,
  EditorSnapshotSelection,
} from './types'
export { renderCurrentFilePointerInjection } from './currentFilePointerContext'
export { renderEditorSnapshotInjection } from './editorSnapshotContext'

export type RenderContextualInjectionContext = CurrentFilePointerRenderContext

export async function renderContextualInjection(
  injection: ContextualInjection,
  ctx: RenderContextualInjectionContext,
): Promise<RequestMessage | null> {
  switch (injection.type) {
    case 'current-file-pointer':
      return renderCurrentFilePointerInjection(injection, ctx)
    case 'editor-snapshot':
      return renderEditorSnapshotInjection(injection)
  }
}

/**
 * Append rendered contextual injections to the tail user message. If the tail
 * is not a user message (e.g. mid-tool-loop the tail may be assistant/tool),
 * the injection is appended as an independent user message instead.
 */
export async function appendContextualInjectionsToLastUserMessage(
  requestMessages: RequestMessage[],
  injections: ContextualInjection[],
  ctx: RenderContextualInjectionContext,
): Promise<RequestMessage[]> {
  if (injections.length === 0) {
    return requestMessages
  }

  const out = [...requestMessages]

  for (const injection of injections) {
    const rendered = await renderContextualInjection(injection, ctx)
    if (!rendered) {
      continue
    }

    const lastIdx = out.length - 1
    const lastMsg = out[lastIdx]
    if (lastMsg && lastMsg.role === 'user') {
      out[lastIdx] = mergeIntoUserMessage(lastMsg, rendered)
    } else {
      out.push(rendered)
    }
  }

  return out
}

function mergeIntoUserMessage(
  userMsg: Extract<RequestMessage, { role: 'user' }>,
  appended: RequestMessage,
): Extract<RequestMessage, { role: 'user' }> {
  const userParts = toContentParts(userMsg.content)
  const appendedParts = toContentParts(appended.content)
  return { ...userMsg, content: [...userParts, ...appendedParts] }
}

function toContentParts(content: string | ContentPart[]): ContentPart[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }
  return content
}
