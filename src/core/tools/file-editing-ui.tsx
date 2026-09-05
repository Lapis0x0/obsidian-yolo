import type { ReactNode } from 'react'

import { EditDiffView } from '../../components/chat-view/tool-cards/EditDiffView'
import type {
  ToolRenderer,
  ToolRendererProps,
} from '../../components/chat-view/tool-renderers/types'
import {
  ToolCallResponseStatus,
  getToolCallArgumentsObject,
} from '../../types/tool-call.types'
import { editUndoSnapshotStore } from '../../utils/chat/editUndoSnapshotStore'

import { resolveEditDiffSource } from './file-editing-diff'
import { getFileEditingPathChatSummary } from './file-editing-support'

/**
 * The one chat renderer all four file-editing tools share — `fs_edit` and
 * `fs_write` (vault) plus `edit_file` and `write_file` (native filesystem).
 * Agent and Max show the same card for the same kind of change; which
 * filesystem API performed the write is not something the diff should look
 * different for.
 *
 * Shared by four tools rather than owned by one, so it lives beside
 * `file-editing-support.ts` under the same "谁用它谁收留" rule that put the
 * shared path summary there (phase2-migration.md D6).
 *
 * `kind: 'content'`: it replaces both default sections of the expanded card
 * (see `tool-renderers/types.ts`). The arguments JSON it displaces *is* the
 * diff — `oldText`/`newText`/`content` rendered as escaped JSON — and the
 * result JSON only restates what the header's `+N/-M` already says.
 *
 * `definition.ts` never imports this file (master.md §3.2): the import
 * direction is `ui.tsx -> components`, never `definition.ts -> ui.tsx`, so
 * the tool definitions stay free of the React tree.
 */
const render = ({
  toolCallId,
  request,
  response,
}: ToolRendererProps): ReactNode => {
  const source = resolveEditDiffSource(
    request,
    response,
    findUndoSnapshot(toolCallId, request, response),
  )
  if (!source) {
    return null
  }
  return <EditDiffView source={source} />
}

/**
 * The undo snapshot is keyed by the path the *write* recorded, which is not
 * always the `path` argument: the native tools resolve `~`/relative inputs
 * and then hand back the vault-relative form for a file inside the vault
 * (`native/edit-summary.ts`'s `nativeEditSummaryPath`). `editSummary` is
 * written from that same resolved path in the same call
 * (`buildFileChangeSummary`), so it — not the raw argument — is what the
 * lookup keys on, with the argument left as the fallback for a response that
 * carries no summary.
 */
const findUndoSnapshot = (
  toolCallId: string,
  request: ToolRendererProps['request'],
  response: ToolRendererProps['response'],
) => {
  const summaryPath =
    response.status === ToolCallResponseStatus.Success
      ? response.data.metadata?.editSummary?.files[0]?.path
      : undefined
  const argumentsObject = getToolCallArgumentsObject(request.arguments)
  const argumentPath =
    typeof argumentsObject?.path === 'string' ? argumentsObject.path : undefined
  const path = summaryPath ?? argumentPath
  return path ? editUndoSnapshotStore.get(toolCallId, path) : undefined
}

export const fileEditingRenderer: ToolRenderer = {
  kind: 'content',
  render,
  summary: getFileEditingPathChatSummary,
}
