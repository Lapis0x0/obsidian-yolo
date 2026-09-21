import {
  type FileChangeRows,
  type ToolCallRequest,
  type ToolCallResponse,
  ToolCallResponseStatus,
  getToolCallArgumentsObject,
} from '../../types/tool-call.types'
import type { EditUndoSnapshot } from '../../utils/chat/editUndoSnapshotStore'
import { materializeTextEditPlan } from '../edits/textEditEngine'
import { InvalidToolNameException } from '../mcp/exception'
import { parseToolName } from '../mcp/tool-name-utils'

import {
  buildFileChangeRowsFromContent,
  buildFileChangeRowsFromTexts,
} from './file-change-rows'
import { getFsEditPlan } from './fs_edit/schema-helpers'

/**
 * The statuses whose card draws the file change instead of the default
 * sections. The one place this is decided, for native and CLI calls alike.
 *
 * - `Success` — the change happened; draw what it was.
 * - `PendingApproval` — nothing has been written yet and there is no error
 *   to read; what the user needs in order to decide is what would change.
 * - `Running` — the call is under way (for a CLI runtime this can be the
 *   whole wait for the user's approval, or the agent writing after it); what
 *   it is changing is already known and is what the user is looking for.
 *
 * Failed and rejected calls keep the default error / rejection sections.
 *
 * This gate answers "is there a change to show", not "is the disk in a known
 * state". A mid-write disk is neither the before nor the after, so the
 * sources that depend on what is on disk or what the write left behind
 * restrict themselves to the status where that holds (see the resolver
 * body); rows fixed when the call was made — pre-built rows, an
 * `oldText`/`newText` pair in the arguments — hold in every status here.
 */
const DRAWN_STATUSES: ReadonlySet<ToolCallResponse['status']> = new Set([
  ToolCallResponseStatus.Success,
  ToolCallResponseStatus.PendingApproval,
  ToolCallResponseStatus.Running,
])

/**
 * A pending call whose before-text is the file as it is on disk right now —
 * an overwrite (`fs_write` / `write_file`) or an `fs_edit` line-range edit.
 * "Waiting for approval" means the write has not happened, so the current
 * content *is* the before-text; the resolver is pure and cannot read it, so
 * it hands this back and the card reads the file (`file-editing-ui.tsx`),
 * then finishes with {@link buildPendingFileChangeRows}.
 */
export type PendingCurrentFileRead = {
  path: string
  /** Which API reaches the file: the vault (`fs_*`) or `node:fs` (native). */
  filesystem: 'vault' | 'native'
  /** The post-edit text given the current one (`null` = no file yet). */
  applyTo: (currentText: string | null) => string | null
  /** What the call writes, shown alone when the current text is unobtainable. */
  writtenText: string
}

/** What reading the file on disk found. */
export type CurrentFileText =
  | { state: 'absent' }
  | { state: 'text'; text: string }
  | { state: 'unreadable' }

export type FileChangeResolution =
  | { type: 'rows'; files: FileChangeRows[] }
  | { type: 'readCurrent'; read: PendingCurrentFileRead }

export type FileChangeResolverContext = {
  /** This call's in-memory undo snapshot, when one survives. */
  undoSnapshot?: EditUndoSnapshot
}

const NATIVE_FILESYSTEM_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
])

const getStringArg = (
  args: Record<string, unknown> | undefined,
  key: string,
): string | undefined => {
  const value = args?.[key]
  return typeof value === 'string' ? value : undefined
}

const getFilesystem = (requestName: string): 'vault' | 'native' => {
  try {
    return NATIVE_FILESYSTEM_TOOLS.has(parseToolName(requestName).toolName)
      ? 'native'
      : 'vault'
  } catch (error) {
    if (!(error instanceof InvalidToolNameException)) {
      throw error
    }
    return 'vault'
  }
}

/**
 * The single resolver of what a file-editing card draws, for every producer.
 *
 * Pre-built rows on the request (`metadata.fileChangeRows`, a CLI runtime's
 * mapping layer) are used as they are, and they are a CLI call's only
 * source: its arguments are provider-native, so reading them as the native
 * tools' `path` / `content` / `oldText` would only ever match by coincidence
 * of field names. Otherwise the call is one of the native file tools
 * (`fs_edit`, `fs_write`, `edit_file`, `write_file`) and its rows are
 * computed here, from the source most precise to *this call*:
 *
 * 1. **The arguments themselves** (`oldText` + `newText`) — `fs_edit`'s
 *    exact-replace mode and `edit_file` carry the whole change in the call,
 *    persisted with the message, so it reads the same in every status and
 *    after a reload.
 * 2. **Pending approval: the file on disk** — for an overwrite or a
 *    line-range edit the arguments hold no original text, but nothing has
 *    been written yet, so the current content is the before-text. Returned
 *    as `readCurrent` for the card to finish.
 * 3. **The in-memory undo snapshot** — this call's own before/after full
 *    text (keyed by `toolCallId + path`). Lost on reload and evicted past a
 *    size cap; both fall through.
 * 4. **`editSummary.operation === 'create'`** — a pure creation has no
 *    before-content to lose, so the written content is, exactly, all added.
 * 5. **The written content alone** (`afterOnly`) — an overwrite whose
 *    snapshot is gone. The card says so instead of guessing.
 *
 * Deliberately NOT consulted: the IndexedDB review snapshot
 * (`database/edit-review/editReviewSnapshotStore.ts`). It accumulates the
 * whole round, so when a turn touches the same file twice its before-content
 * belongs to the first write, not to the call whose card is open.
 *
 * Returns `null` when there is nothing to draw — a status outside
 * {@link DRAWN_STATUSES}, a CLI call without pre-built rows, a call with no
 * `path`, nothing written to show, or a native call still running whose
 * change only a finished write can describe.
 */
export const resolveFileChangeRows = (
  request: Pick<ToolCallRequest, 'name' | 'arguments' | 'metadata'>,
  response: ToolCallResponse,
  context: FileChangeResolverContext = {},
): FileChangeResolution | null => {
  if (!DRAWN_STATUSES.has(response.status)) {
    return null
  }

  const prebuilt = request.metadata?.fileChangeRows
  if (prebuilt || request.metadata?.cliToolCall) {
    return prebuilt && prebuilt.length > 0
      ? { type: 'rows', files: prebuilt }
      : null
  }

  const args = getToolCallArgumentsObject(request.arguments)
  const path = getStringArg(args, 'path')
  if (!path) {
    return null
  }

  const oldText = getStringArg(args, 'oldText')
  const newText = getStringArg(args, 'newText')
  if (oldText !== undefined && newText !== undefined) {
    return rows(buildFileChangeRowsFromTexts(path, oldText, newText))
  }

  // `content` is `fs_write` / `write_file`'s full-content argument;
  // `newText` alone is `fs_edit`'s line-range mode (no `oldText` to pair
  // with, which is why it fell through the branch above).
  const content = getStringArg(args, 'content')
  const writtenText = content ?? newText
  if (writtenText === undefined) {
    return null
  }

  if (response.status === ToolCallResponseStatus.PendingApproval) {
    return {
      type: 'readCurrent',
      read: {
        path,
        filesystem: getFilesystem(request.name),
        applyTo:
          content !== undefined
            ? () => content
            : (currentText) => applyLineRangeEdit(args ?? {}, currentText),
        writtenText,
      },
    }
  }

  // Every source below describes a finished write: the undo snapshot and
  // `editSummary` are what the write left behind, and `afterOnly` claims the
  // before-text is gone. While the call is still running none of that holds
  // yet, so it keeps the default sections until it completes.
  if (response.status !== ToolCallResponseStatus.Success) {
    return null
  }

  const { undoSnapshot } = context
  if (undoSnapshot) {
    return rows(
      buildFileChangeRowsFromTexts(
        path,
        undoSnapshot.beforeExists ? undoSnapshot.beforeContent : '',
        undoSnapshot.afterExists ? undoSnapshot.afterContent : '',
      ),
    )
  }

  // Each of these four tools writes exactly one file per call, so a single
  // `create` entry is unambiguous — matched by count and operation rather
  // than by path, because the native tools report the *resolved* path while
  // the argument may be relative or `~`-prefixed.
  const editedFiles = response.data.metadata?.editSummary?.files ?? []
  const isPureCreation =
    editedFiles.length === 1 && editedFiles[0].operation === 'create'
  if (isPureCreation) {
    return rows(buildFileChangeRowsFromTexts(path, '', writtenText))
  }

  return rows(buildFileChangeRowsFromContent(path, writtenText))
}

const rows = (file: FileChangeRows): FileChangeResolution => ({
  type: 'rows',
  files: [file],
})

/**
 * `fs_edit`'s line-range edit applied to the current text, through the same
 * plan parser and engine the tool executes with — so the preview is what the
 * write would do, or `null` where the write itself would fail.
 */
const applyLineRangeEdit = (
  args: Record<string, unknown>,
  currentText: string | null,
): string | null => {
  if (currentText === null) {
    return null
  }
  let plan: ReturnType<typeof getFsEditPlan>
  try {
    plan = getFsEditPlan(args)
  } catch {
    return null
  }
  const materialized = materializeTextEditPlan({ content: currentText, plan })
  return materialized.errors.length > 0 ? null : materialized.newContent
}

/**
 * Finishes a {@link PendingCurrentFileRead} once the card has read the file:
 * a real diff against the current text (or against nothing, for a file that
 * does not exist yet), or the written content alone when the file could not
 * be read or the edit does not apply to it.
 */
export const buildPendingFileChangeRows = (
  read: PendingCurrentFileRead,
  current: CurrentFileText,
): FileChangeRows => {
  if (current.state !== 'unreadable') {
    const beforeText = current.state === 'text' ? current.text : null
    const afterText = read.applyTo(beforeText)
    if (afterText !== null) {
      return buildFileChangeRowsFromTexts(
        read.path,
        beforeText ?? '',
        afterText,
      )
    }
  }
  return buildFileChangeRowsFromContent(read.path, read.writtenText)
}
