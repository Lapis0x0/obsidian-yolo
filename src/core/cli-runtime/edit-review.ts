import {
  type EditReviewSnapshotApp,
  upsertEditReviewSnapshot,
} from '../../database/edit-review/editReviewSnapshotStore'

import { type CliSessionRef, getCliSessionConversationId } from './types'

/**
 * Records one CLI call's change to one file as an edit review snapshot — what
 * the edit summary panel's review overlay opens from.
 *
 * Keyed the way the chat surface reads it back: under the session's
 * conversation id, with the call's own tool message id as the round, which is
 * the `reviewRoundId` the call's `editSummary` carries. One record per call,
 * not per turn: the panel looks up the first and the latest call that touched
 * the file, and both have to be there (`usableSnapshotPair`). A second record
 * for the same key keeps the first before-text (`upsertEditReviewSnapshot`).
 *
 * The texts must be whole files the runtime has checked against disk: the
 * overlay diffs `beforeContent` against the file as it is, so a before-text
 * that was only the agent's claim would show changes that never happened.
 * `beforeContent: null` records that the call created the file.
 */
export const recordCliEditReviewSnapshot = async ({
  app,
  sessionRef,
  roundId,
  path,
  beforeContent,
  afterContent,
}: {
  app: EditReviewSnapshotApp
  sessionRef: CliSessionRef
  roundId: string
  path: string
  beforeContent: string | null
  afterContent: string
}): Promise<void> => {
  await upsertEditReviewSnapshot({
    app,
    conversationId: getCliSessionConversationId(sessionRef),
    roundId,
    filePath: path,
    beforeContent: beforeContent ?? '',
    afterContent,
    beforeExists: beforeContent !== null,
    afterExists: true,
  })
}
