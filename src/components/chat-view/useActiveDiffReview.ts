import { normalizePath } from 'obsidian'
import { useSyncExternalStore } from 'react'

import { usePlugin } from '../../contexts/plugin-context'
import { getLocalFileToolServerName } from '../../core/mcp/localFileToolNames'
import { parseToolName } from '../../core/mcp/tool-name-utils'
import type { ActiveDiffReview } from '../../features/editor/diff-review/diffReviewController'
import {
  type ToolCallRequest,
  type ToolCallResponse,
  ToolCallResponseStatus,
  getToolCallArgumentsObject,
} from '../../types/tool-call.types'

/** The inline diff review currently open in the editor, if any, and a way
 * to bring it to the front. */
export function useActiveDiffReview(): {
  activeReview: ActiveDiffReview | null
  revealActiveReview: () => void
} {
  const controller = usePlugin().getDiffReviewController()
  const activeReview = useSyncExternalStore(
    controller.subscribeActiveReview,
    controller.getActiveReview,
  )
  return {
    activeReview,
    revealActiveReview: () => {
      void controller.revealActiveReview()
    },
  }
}

/**
 * Whether this `fs_edit` call is the one the open review is waiting on. Its
 * status alone cannot tell: under review, `fs_edit` stays `running` for as
 * long as the user takes in the editor. Matched by conversation and path,
 * not call id — sibling edits to one file share a single review opened under
 * the first call's id.
 */
export function isFsEditAwaitingReview({
  request,
  response,
  conversationId,
  activeReview,
}: {
  request: Pick<ToolCallRequest, 'name' | 'arguments'>
  response: ToolCallResponse
  conversationId: string | undefined
  activeReview: ActiveDiffReview | null
}): boolean {
  if (
    !activeReview ||
    response.status !== ToolCallResponseStatus.Running ||
    activeReview.conversationId !== conversationId
  ) {
    return false
  }
  try {
    const { serverName, toolName } = parseToolName(request.name)
    if (serverName !== getLocalFileToolServerName() || toolName !== 'fs_edit') {
      return false
    }
  } catch {
    return false
  }
  const path = getToolCallArgumentsObject(request.arguments)?.path
  return (
    typeof path === 'string' &&
    normalizePath(path).trim() === activeReview.filePath
  )
}
