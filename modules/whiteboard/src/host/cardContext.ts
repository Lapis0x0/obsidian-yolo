// The vault half of a card's context (master.md §4): read what the pure
// assembly in `domain/cardContext.ts` needs, then build it.
//
// The async boundary sits exactly here. Reading files is the only thing about
// a card's context that cannot be answered from the board, so it is the only
// thing that awaits — everything downstream of `resolveCardContextNotes` is
// synchronous and can be re-run against a board that has since changed
// without touching the vault again. That is what a synchronous consumer
// (Quick Ask's `getContext`, W4) is meant to hold: the notes, resolved once,
// and `buildCardContext` called on demand.
//
// Two reads per note in the worst case (a clipped preview for the summary,
// the whole file for a source) and one for every other note card. Sources are
// a handful of cards by construction — they are what someone drew an arrow
// from — so the whole-file reads are bounded by the user's own gesture, not
// by the board.

import {
  type CardContextNoteTexts,
  buildCardContext,
  cardSourceNotePaths,
} from '../domain/cardContext'
import type { Board, NodeId } from '../domain/fileFormat'

import { readNoteBody, readNotePreviews } from './noteText'

/**
 * Every note text this card's context wants: a clipped preview for each note
 * card on the board, the whole file for each one that is a source.
 */
export async function resolveCardContextNotes(
  host: YoloModuleHostApiV1,
  board: Board,
  nodeId: NodeId,
): Promise<CardContextNoteTexts> {
  const texts = await readNotePreviews(host, board)
  for (const notePath of cardSourceNotePaths(board, nodeId)) {
    const body = await readNoteBody(host, notePath)
    if (body !== null) texts.set(notePath, body)
  }
  return texts
}

/** The context text for one card, notes and all. */
export async function resolveCardContext(
  host: YoloModuleHostApiV1,
  board: Board,
  nodeId: NodeId,
  path: string,
): Promise<string> {
  return buildCardContext({
    board,
    nodeId,
    path,
    noteTexts: await resolveCardContextNotes(host, board, nodeId),
  })
}
