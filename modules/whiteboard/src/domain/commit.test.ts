import { planCardCommit } from './commit'
import { type Board, emptyBoard } from './fileFormat'

function boardWith(...cards: Board['cards']): Board {
  return { ...emptyBoard(), cards }
}

const noteCard = {
  id: 'c1',
  type: 'note' as const,
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  file: 'Cards/note.md',
  extra: {},
}

const textCard = {
  id: 'c2',
  type: 'text' as const,
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  markdown: 'old text',
  extra: {},
}

const pdfCard = {
  id: 'c3',
  type: 'pdf' as const,
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  file: 'papers/foo.pdf',
  page: 1,
  extra: {},
}

describe('planCardCommit', () => {
  it('plans a note-file write for a note card, leaving the board untouched', () => {
    const board = boardWith(noteCard)
    const action = planCardCommit(board, 'c1', 'new note text')
    expect(action).toEqual({
      kind: 'writeNoteFile',
      file: 'Cards/note.md',
      markdown: 'new note text',
    })
  })

  it('plans a board update for a text card, patching only its markdown', () => {
    const board = boardWith(textCard)
    const action = planCardCommit(board, 'c2', 'new text')
    expect(action.kind).toBe('updateBoard')
    if (action.kind !== 'updateBoard') throw new Error('unreachable')
    const updated = action.board.cards.find((card) => card.id === 'c2')
    expect(updated).toMatchObject({ markdown: 'new text' })
    // Only the touched card's reference changes; untouched cards from the
    // same board keep theirs (repo-wide immutable-update invariant).
    expect(action.board).not.toBe(board)
  })

  it('is a no-op for a pdf card (not editable in M1)', () => {
    const board = boardWith(pdfCard)
    expect(planCardCommit(board, 'c3', 'ignored')).toEqual({ kind: 'noop' })
  })

  it('is a no-op when the card id is not found', () => {
    const board = boardWith(textCard)
    expect(planCardCommit(board, 'missing', 'ignored')).toEqual({ kind: 'noop' })
  })

  it('leaves an untouched card reference-equal across an updateBoard commit', () => {
    const board = boardWith(noteCard, textCard)
    const action = planCardCommit(board, 'c2', 'edited')
    if (action.kind !== 'updateBoard') throw new Error('unreachable')
    const untouched = action.board.cards.find((card) => card.id === 'c1')
    expect(untouched).toBe(noteCard)
  })
})
