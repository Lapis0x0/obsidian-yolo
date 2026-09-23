import type { App } from 'obsidian'

import type {
  ChatMessage,
  ChatUserMessage,
  InjectedContextPart,
} from '../../../types/chat'
import type { ContentPart } from '../../../types/llm/request'
import { tFileToImageDataUrl } from '../../llm/image'

import { renderBrowserContextInjection } from './browserContext'
import { renderCurrentFilePointerInjection } from './currentFilePointerContext'
import { renderEditorSnapshotInjection } from './editorSnapshotContext'
import { renderSurfaceContextInjection } from './surfaceContext'
import type { ContextualInjection } from './types'

export type {
  BrowserContextInjection,
  ContextualInjection,
  CurrentFilePointerInjection,
  EditorSnapshotInjection,
  EditorSnapshotSelection,
  SurfaceContextInjection,
} from './types'
export { renderBrowserContextInjection } from './browserContext'
export { renderCurrentFilePointerInjection } from './currentFilePointerContext'
export { renderEditorSnapshotInjection } from './editorSnapshotContext'
export { renderSurfaceContextInjection } from './surfaceContext'

async function renderContextualInjection(
  injection: ContextualInjection,
): Promise<InjectedContextPart[] | null> {
  switch (injection.type) {
    case 'current-file-pointer':
      return renderCurrentFilePointerInjection(injection)
    case 'editor-snapshot':
      return renderEditorSnapshotInjection(injection)
    case 'surface-context':
      return renderSurfaceContextInjection(injection)
    case 'browser-context':
      return renderBrowserContextInjection(injection)
  }
}

/**
 * Fix the user's surroundings onto a message entering the conversation as a
 * new turn. Every later request sends exactly what was stamped here, so the
 * request history only grows and a provider's prefix cache and reasoning
 * signatures stay valid. A message already stamped keeps its context, which
 * is what a retry or a continuation wants.
 */
export async function stampUserMessageInjectedContext(
  message: ChatUserMessage,
  injections: readonly ContextualInjection[],
): Promise<ChatUserMessage> {
  if (message.injectedContext) {
    return message
  }
  const parts: InjectedContextPart[] = []
  for (const injection of injections) {
    const rendered = await renderContextualInjection(injection)
    if (rendered) parts.push(...rendered)
  }
  return { ...message, injectedContext: parts }
}

/**
 * Stamp the last message when it is a user message entering the conversation.
 * Returns the input array itself when nothing changed.
 */
export async function stampLatestUserMessageInjectedContext(
  messages: ChatMessage[],
  injections: readonly ContextualInjection[],
): Promise<ChatMessage[]> {
  const last = messages.at(-1)
  if (last?.role !== 'user') {
    return messages
  }
  const stamped = await stampUserMessageInjectedContext(last, injections)
  return stamped === last ? messages : [...messages.slice(0, -1), stamped]
}

/** The stamped context as request content; an image no longer in the vault is left out. */
export async function renderInjectedContext(
  parts: readonly InjectedContextPart[],
  app: App,
): Promise<ContentPart[]> {
  const content: ContentPart[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      content.push({ type: 'text', text: part.text })
      continue
    }
    const file = app.vault.getFileByPath(part.path)
    if (!file) continue
    try {
      const url = await tFileToImageDataUrl(app, file, { cache: true })
      content.push({ type: 'image_url', image_url: { url } })
    } catch (error) {
      console.warn('[YOLO] Failed to read context image', part.path, error)
    }
  }
  return content
}
