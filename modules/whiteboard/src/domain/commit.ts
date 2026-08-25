// Pure decision logic for "what does committing a card's live-edited text
// actually do", factored out of the DOM-heavy canvas UI so the blur/Escape/
// dispose commit paths (src/ui/canvas.ts) all route through one testable
// choke point rather than each re-deriving "note card -> write the file,
// text card -> updateCard" independently (docs/plans/08-25-yolo-whiteboard/
// p1-design.md §1.2, §3: "Escape/blur 共用同一提交路径，不双写").
//
// A pdf card is never edited in M1 (p1-design §6, M1 scope), so committing
// one is a no-op rather than a reachable case — callers should not be
// invoking this for a pdf card in practice, but a defensive no-op is safer
// than an exception on a future data/UI desync.

import type { Board, CardId } from './fileFormat'
import { updateCard } from './operations'

export type CardCommitAction =
  | Readonly<{ kind: 'writeNoteFile'; file: string; markdown: string }>
  | Readonly<{ kind: 'updateBoard'; board: Board }>
  | Readonly<{ kind: 'noop' }>

/**
 * `board` must be the board the card currently lives in; `markdown` is the
 * live text read from the card's editor at commit time. Returns what to do
 * with it — the caller performs the actual I/O (vault write / requestSave).
 */
export function planCardCommit(
  board: Board,
  cardId: CardId,
  markdown: string,
): CardCommitAction {
  const card = board.cards.find((candidate) => candidate.id === cardId)
  if (!card) return { kind: 'noop' }
  switch (card.type) {
    case 'note':
      return { kind: 'writeNoteFile', file: card.file, markdown }
    case 'text':
      return { kind: 'updateBoard', board: updateCard(board, cardId, { markdown }) }
    case 'pdf':
      return { kind: 'noop' }
  }
}
