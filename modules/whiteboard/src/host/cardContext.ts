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
  cardBlock,
  cardSourceNotePaths,
  cardsInsideGroup,
} from '../domain/cardContext'
import type { Board, BoardNode, NodeId } from '../domain/fileFormat'
import { fileNodeKind } from '../domain/naming'

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

/**
 * One card in full, as `read_card` returns it (master.md §5): the card's own
 * text, a note card's whole note, and a group's members one after another —
 * asking for a group is asking for what is in it.
 *
 * Null means no such card, which the tool reports as a failed read rather
 * than as an empty one.
 */
export async function readCardForModel(
  host: YoloModuleHostApiV1,
  board: Board,
  cardId: NodeId,
): Promise<string | null> {
  const card = board.nodes.find((node) => node.id === cardId)
  if (!card) return null
  const cards = card.type === 'group' ? cardsInsideGroup(board, card) : [card]
  const noteTexts = new Map<string, string>()
  for (const path of notePathsOf(cards)) {
    const body = await readNoteBody(host, path)
    if (body !== null) noteTexts.set(path, body)
  }
  if (card.type === 'group' && cards.length === 0) {
    return `${card.id} is a group with no cards inside it.`
  }
  return cards.flatMap((node) => cardBlock(node, noteTexts)).join('\n')
}

function notePathsOf(cards: readonly BoardNode[]): string[] {
  const paths: string[] = []
  for (const card of cards) {
    if (card.type !== 'file') continue
    if (fileNodeKind(card.file) !== 'markdown') continue
    if (!paths.includes(card.file)) paths.push(card.file)
  }
  return paths
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
