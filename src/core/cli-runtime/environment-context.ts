import type { App, TFile } from 'obsidian'

import type { YoloSettings } from '../../settings/schema/setting.types'
import type { ContentPart, RequestMessage } from '../../types/llm/request'
import type { CurrentFileViewState } from '../../types/mentionable'
import {
  renderBrowserContextInjection,
  renderCurrentFilePointerInjection,
} from '../../utils/chat/contextual-injections'

import { RUNTIME_CAPABILITIES } from './capabilities'
import type { CliRuntimeId } from './types'

export type BuildCliEnvironmentContextInput = {
  app: App
  runtimeId: CliRuntimeId
  settings: YoloSettings
  currentFile: TFile | null
  currentFileViewState?: CurrentFileViewState
}

const toContentParts = (message: RequestMessage | null): ContentPart[] => {
  if (!message || message.role !== 'user') return []
  return typeof message.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : message.content
}

/**
 * Capture the Obsidian environment visible when a new CLI turn is submitted.
 * The returned parts become provider-owned turn content, so retries and
 * continuations retain the original snapshot instead of following later UI
 * focus changes.
 */
export const buildCliEnvironmentContext = async ({
  app,
  runtimeId,
  settings,
  currentFile,
  currentFileViewState,
}: BuildCliEnvironmentContextInput): Promise<ContentPart[]> => {
  const [currentFileContext, browserContext] = await Promise.all([
    currentFile
      ? renderCurrentFilePointerInjection(
          {
            type: 'current-file-pointer',
            file: currentFile,
            viewState: currentFileViewState,
          },
          { app, settings },
        )
      : Promise.resolve(null),
    renderBrowserContextInjection({ type: 'browser-context', app }),
  ])

  const parts = [
    ...toContentParts(currentFileContext),
    ...toContentParts(browserContext),
  ]

  // Viewing an image file makes the current-file pointer contribute the
  // image itself. A runtime that takes no images would fail the whole turn
  // over context the user never attached, so drop just that part — the
  // pointer text naming the file still goes through.
  return RUNTIME_CAPABILITIES[runtimeId].supportsImageAttachments
    ? parts
    : parts.filter((part) => part.type !== 'image_url')
}
