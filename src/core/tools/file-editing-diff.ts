import {
  type ToolCallRequest,
  type ToolCallResponse,
  ToolCallResponseStatus,
  getToolCallArgumentsObject,
} from '../../types/tool-call.types'
import type { EditUndoSnapshot } from '../../utils/chat/editUndoSnapshotStore'

/**
 * What the expanded card of a file-editing tool call should diff.
 *
 * - `exact` — both sides are known to be what *this* call changed, so the
 *   card shows a real before/after diff.
 * - `afterOnly` — only the written content survived; the pre-edit content is
 *   gone (see `resolveEditDiffSource`'s last branch). The card renders the
 *   new content plainly, with a note, rather than dressing it up as a diff
 *   it cannot compute.
 */
export type EditDiffSource =
  | {
      kind: 'exact'
      path: string
      beforeText: string
      afterText: string
    }
  | {
      kind: 'afterOnly'
      path: string
      afterText: string
    }

const getStringArg = (
  args: Record<string, unknown> | undefined,
  key: string,
): string | undefined => {
  const value = args?.[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Picks the most trustworthy before/after pair available for one
 * file-editing tool call (`fs_edit`, `fs_write`, `edit_file`, `write_file`).
 *
 * The order below is "precise to this call" first, never "most complete
 * text" first:
 *
 * 1. **The arguments themselves** (`oldText` + `newText`) — `fs_edit`'s
 *    exact-replace mode and `edit_file` carry the whole change in the call,
 *    persisted with the message. This is the only source that still works
 *    after a reload, and it is scoped to exactly the fragment the model
 *    rewrote, so the card reads the same on the first render and on the
 *    hundredth.
 * 2. **The in-memory undo snapshot** — keyed by `toolCallId + path`, so it
 *    is this call's own before/after full text. Covers `fs_write` /
 *    `write_file` overwrites and `fs_edit`'s line-range mode, where the
 *    arguments hold no original text. It does not survive a reload and is
 *    evicted past a size cap; both simply fall through to a later branch.
 * 3. **`editSummary.operation === 'create'`** — a pure creation has no
 *    before-content to lose, so the written content is, exactly, all added.
 *    Persisted with the message, so it keeps working after a reload.
 * 4. **The written content alone** — everything else: an overwrite whose
 *    snapshot is gone (reload, eviction, or a file too large to snapshot).
 *    The card says so instead of guessing.
 *
 * Deliberately NOT consulted: the IndexedDB review snapshot
 * (`database/edit-review/editReviewSnapshotStore.ts`). It is keyed by
 * conversation + round + path and accumulates *the whole round*, so when a
 * turn touches the same file twice its before-content belongs to the first
 * write, not to the call whose card is open. A diff that is wrong in exactly
 * the case the user most needs it (repeated edits to one file) is worse than
 * saying the original is unavailable.
 *
 * Returns `null` when there is nothing worth drawing — any non-`Success`
 * status (the default error / rejection sections stay in charge), a call
 * with no `path`, or a call with no written content to show either.
 */
export const resolveEditDiffSource = (
  request: Pick<ToolCallRequest, 'arguments'>,
  response: ToolCallResponse,
  undoSnapshot?: EditUndoSnapshot,
): EditDiffSource | null => {
  if (response.status !== ToolCallResponseStatus.Success) {
    return null
  }

  const args = getToolCallArgumentsObject(request.arguments)
  const path = getStringArg(args, 'path')
  if (!path) {
    return null
  }

  const oldText = getStringArg(args, 'oldText')
  const newText = getStringArg(args, 'newText')
  if (oldText !== undefined && newText !== undefined) {
    return { kind: 'exact', path, beforeText: oldText, afterText: newText }
  }

  if (undoSnapshot) {
    return {
      kind: 'exact',
      path,
      beforeText: undoSnapshot.beforeExists ? undoSnapshot.beforeContent : '',
      afterText: undoSnapshot.afterExists ? undoSnapshot.afterContent : '',
    }
  }

  // `content` is `fs_write` / `write_file`'s full-content argument;
  // `newText` alone is `fs_edit`'s line-range mode (no `oldText` to pair
  // with, which is why it falls through the first branch).
  const writtenText = getStringArg(args, 'content') ?? newText
  if (writtenText === undefined) {
    return null
  }

  // Each of these four tools writes exactly one file per call, so a single
  // `create` entry is unambiguous — matched by count and operation rather
  // than by path, because the native tools report the *resolved* absolute
  // path while the argument may be relative or `~`-prefixed.
  const editedFiles = response.data.metadata?.editSummary?.files ?? []
  const isPureCreation =
    editedFiles.length === 1 && editedFiles[0].operation === 'create'
  if (isPureCreation) {
    return { kind: 'exact', path, beforeText: '', afterText: writtenText }
  }

  return { kind: 'afterOnly', path, afterText: writtenText }
}
