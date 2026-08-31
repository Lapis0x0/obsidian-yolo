import type { App } from 'obsidian'

import { upsertEditReviewSnapshot } from '../../database/json/chat/editReviewSnapshotStore'
import type { YoloSettings } from '../../settings/schema/setting.types'
import type { ToolEditSummary } from '../../types/tool-call.types'
import {
  createToolEditSummary,
  deriveToolEditUndoStatus,
  hasFileContentChanged,
} from '../../utils/chat/editSummary'
import { editUndoSnapshotStore } from '../../utils/chat/editUndoSnapshotStore'
import type { PromptSourceWatcher } from '../agent/promptSourceWatcher'

import type { LocalToolCallResultMetadata } from './types'

/**
 * Helpers shared by both `file_editing` tools (`fs_edit`, `fs_write`) — not
 * a single-tool concern, so (per phase2-migration.md D6 "注意": "谁用它谁
 * 收留") this lives alongside the capability rather than inside either
 * tool's own directory, mirroring the precedent set by
 * `memory-tool-support.ts` for the three memory tools.
 *
 * Ported verbatim from `core/mcp/localFileTools.ts` (pre-migration).
 * `localFileTools.ts`'s still-live `case 'fs_edit'` / `case 'fs_write'`
 * switch branches import these back from here rather than the reverse — see
 * that file's import block and
 * docs/plans/2026-08-15-tool-registry/master.md D6a.
 */

/**
 * Build an editSummary (+ chat-undo snapshot + review snapshot) for a
 * file content change (create/overwrite/delete) and accumulate it into a
 * single-file result. Returns the metadata for the tool response.
 */
export const buildFileChangeSummary = async ({
  app,
  settings,
  path,
  beforeContent,
  afterContent,
  beforeExists,
  afterExists,
  conversationId,
  roundId,
  toolCallId,
  appliedAt,
}: {
  app: App
  settings?: YoloSettings
  path: string
  beforeContent: string
  afterContent: string
  beforeExists: boolean
  afterExists: boolean
  conversationId?: string
  roundId?: string
  toolCallId?: string
  appliedAt: number
}): Promise<LocalToolCallResultMetadata | undefined> => {
  const changed = hasFileContentChanged({
    beforeContent,
    afterContent,
    beforeExists,
    afterExists,
  })

  if (toolCallId && changed) {
    editUndoSnapshotStore.set({
      toolCallId,
      path,
      beforeContent,
      afterContent,
      beforeExists,
      afterExists,
      appliedAt,
    })
  }

  // 有会话上下文时，最终展示的行数来自 review 快照（它统计的是本轮累计，而
  // 不是本次编辑），会把 `createToolEditSummary` 自己算的数字整个覆盖掉。所以
  // 先拿到快照，再用它的数字建摘要——否则同一份内容要跑两次全文 diff，其中
  // 一次的结果算完就被丢弃。
  let editSummary: ToolEditSummary | undefined
  if (changed && conversationId && roundId) {
    const snapshot = await upsertEditReviewSnapshot({
      app,
      conversationId,
      roundId,
      filePath: path,
      beforeContent,
      afterContent,
      beforeExists,
      afterExists,
      settings,
    })
    editSummary = createToolEditSummary({
      path,
      beforeContent,
      afterContent,
      beforeExists,
      afterExists,
      reviewRoundId: roundId,
      counts: {
        addedLines: snapshot.addedLines,
        removedLines: snapshot.removedLines,
        lineStatsAvailable: snapshot.lineStatsAvailable,
      },
    })
  } else {
    editSummary = createToolEditSummary({
      path,
      beforeContent,
      afterContent,
      beforeExists,
      afterExists,
      reviewRoundId: roundId,
    })
  }

  if (!editSummary) {
    return undefined
  }

  return {
    editSummary: {
      files: editSummary.files,
      totalFiles: editSummary.files.length,
      totalAddedLines: editSummary.totalAddedLines,
      totalRemovedLines: editSummary.totalRemovedLines,
      undoStatus: deriveToolEditUndoStatus(editSummary.files),
    },
    appliedAt,
  }
}

export async function maybeWithInternalWrite<T>(
  promptSourceWatcher: PromptSourceWatcher | undefined,
  path: string,
  task: () => Promise<T>,
): Promise<T> {
  if (promptSourceWatcher?.isWatchedPath(path)) {
    return promptSourceWatcher.withInternalWrite(path, task)
  }
  return task()
}

/**
 * Chat-surface summary shared by both `file_editing` tools — `fs_edit` and
 * `fs_write` render the same "which path" summary. Ported verbatim from the
 * `toolName === 'fs_edit'` / `toolName === 'fs_write'` branches of
 * `ToolMessage.tsx`'s private `getLocalToolSummaryText` (pre-D8). Wired into
 * `TOOL_RENDERERS` as each tool's own `summary` field
 * (phase2-migration.md D8) — retired write-action tool names (fs_delete,
 * fs_create_dir, and their even older aliases) used to share this same
 * branch but are deliberately NOT wired to it anymore (master.md decision
 * 10): they have no registry entry, so they fall through to the generic
 * "no summary" rendering instead.
 */
export const getFileEditingPathChatSummary = ({
  argumentsObject,
}: {
  argumentsObject: Record<string, unknown> | null
}): string | undefined => {
  const path =
    typeof argumentsObject?.path === 'string' ? argumentsObject.path : ''
  return path || undefined
}
