import { type App, Platform, TFile } from 'obsidian'
import { type ReactNode, useEffect, useState } from 'react'

import {
  EditDiffView,
  FileChangeList,
  FileChangePath,
} from '../../components/chat-view/tool-cards/EditDiffView'
import type {
  ToolRenderer,
  ToolRendererProps,
} from '../../components/chat-view/tool-renderers/types'
import { useApp } from '../../contexts/app-context'
import { useLanguage } from '../../contexts/language-context'
import {
  ToolCallResponseStatus,
  getToolCallArgumentsObject,
} from '../../types/tool-call.types'
import { editUndoSnapshotStore } from '../../utils/chat/editUndoSnapshotStore'
import { validateVaultPath } from '../mcp/vaultFileOps'

import {
  type CurrentFileText,
  type PendingCurrentFileRead,
  buildPendingFileChangeRows,
  resolveFileChangeRows,
} from './file-change-resolver'
import { getFileEditingPathChatSummary } from './file-editing-support'
import { readNativeCurrentText } from './native/current-text'
import { resolveNativePath } from './native/paths'
import { MAX_FILE_SIZE_BYTES } from './tool-args'

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
 * Which statuses draw a diff is decided by `resolveFileChangeRows` alone;
 * `null` from it hands the card back to the default sections.
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
  const resolution = resolveFileChangeRows(request, response, {
    undoSnapshot: findUndoSnapshot(toolCallId, request, response),
  })
  if (!resolution) {
    return null
  }
  if (resolution.type === 'readCurrent') {
    return <PendingFileChangeView read={resolution.read} />
  }
  return <FileChangeList files={resolution.files} />
}

/**
 * The card of a pending overwrite / line-range edit: reads the file as it is
 * now — the before-text, since nothing has been written yet — and diffs the
 * call against it.
 *
 * This is where reading the disk lives because it is the one place that both
 * has the `App` (`ToolRenderer.render` does not receive one) and is allowed
 * to be asynchronous; the resolver stays a pure function of the call.
 */
function PendingFileChangeView({ read }: { read: PendingCurrentFileRead }) {
  const app = useApp()
  const { t } = useLanguage()
  const [current, setCurrent] = useState<CurrentFileText | null>(null)
  const { path, filesystem } = read

  useEffect(() => {
    let cancelled = false
    setCurrent(null)
    void readCurrentFileText(app, path, filesystem).then((result) => {
      if (!cancelled) {
        setCurrent(result)
      }
    })
    return () => {
      cancelled = true
    }
  }, [app, path, filesystem])

  return (
    <div className="yolo-edit-diff">
      <FileChangePath path={path} />
      {current === null ? (
        <div className="yolo-edit-diff-notice">
          {t('chat.toolCall.editDiff.readingCurrent', '正在读取文件当前内容…')}
        </div>
      ) : (
        <EditDiffView file={buildPendingFileChangeRows(read, current)} />
      )}
    </div>
  )
}

/**
 * The file's current text, through the same filesystem API the tool will
 * write with: the vault for `fs_*`, `node:fs` for the native tools (whose
 * paths may lie outside the vault, and which are desktop-only — read through
 * the shared `readNativeCurrentText`).
 *
 * Files over `MAX_FILE_SIZE_BYTES` — the size past which the write tools
 * themselves stop snapshotting the before-content — and non-text files are
 * reported unreadable rather than diffed. Any read error is too: this only
 * feeds a preview, so it degrades to showing the written content instead of
 * breaking the card.
 */
const readCurrentFileText = async (
  app: App,
  path: string,
  filesystem: PendingCurrentFileRead['filesystem'],
): Promise<CurrentFileText> => {
  try {
    if (filesystem === 'vault') {
      const file = app.vault.getAbstractFileByPath(validateVaultPath(path))
      if (!file) {
        return { state: 'absent' }
      }
      if (!(file instanceof TFile) || file.stat.size > MAX_FILE_SIZE_BYTES) {
        return { state: 'unreadable' }
      }
      return { state: 'text', text: await app.vault.read(file) }
    }

    if (!Platform.isDesktop) {
      return { state: 'unreadable' }
    }
    return await readNativeCurrentText(await resolveNativePath(app, path))
  } catch {
    return { state: 'unreadable' }
  }
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
