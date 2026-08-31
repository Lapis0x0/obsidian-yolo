import { planNodeCommit } from './commit'
import { type Board, emptyBoard } from './fileFormat'

function boardWith(...nodes: Board['nodes']): Board {
  return { ...emptyBoard(), nodes }
}

const noteNode = {
  id: 'c1',
  type: 'file' as const,
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  file: 'Cards/note.md',
  extra: {},
}

const textNode = {
  id: 'c2',
  type: 'text' as const,
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  text: 'old text',
  extra: {},
}

const pdfNode = {
  id: 'c3',
  type: 'file' as const,
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  file: 'papers/foo.pdf',
  extra: {},
}

const groupNode = {
  id: 'g1',
  type: 'group' as const,
  x: 0,
  y: 0,
  w: 400,
  h: 400,
  label: 'Group',
  extra: {},
}

describe('planNodeCommit', () => {
  it('plans a note-file write for a markdown file node, leaving the board untouched', () => {
    const board = boardWith(noteNode)
    const action = planNodeCommit(board, 'c1', 'new note text')
    expect(action).toEqual({
      kind: 'writeNoteFile',
      file: 'Cards/note.md',
      markdown: 'new note text',
    })
  })

  it('plans a board update for a text node, patching only its text', () => {
    const board = boardWith(textNode)
    const action = planNodeCommit(board, 'c2', 'new text')
    expect(action.kind).toBe('updateBoard')
    if (action.kind !== 'updateBoard') throw new Error('unreachable')
    const updated = action.board.nodes.find((node) => node.id === 'c2')
    expect(updated).toMatchObject({ text: 'new text' })
    // Only the touched node's reference changes; untouched nodes from the
    // same board keep theirs (repo-wide immutable-update invariant).
    expect(action.board).not.toBe(board)
  })

  it('is a no-op for a file node that is not markdown', () => {
    const board = boardWith(pdfNode)
    expect(planNodeCommit(board, 'c3', 'ignored')).toEqual({ kind: 'noop' })
  })

  it('is a no-op for a group node', () => {
    const board = boardWith(groupNode)
    expect(planNodeCommit(board, 'g1', 'ignored')).toEqual({ kind: 'noop' })
  })

  it('is a no-op when the node id is not found', () => {
    const board = boardWith(textNode)
    expect(planNodeCommit(board, 'missing', 'ignored')).toEqual({
      kind: 'noop',
    })
  })

  it('leaves an untouched node reference-equal across an updateBoard commit', () => {
    const board = boardWith(noteNode, textNode)
    const action = planNodeCommit(board, 'c2', 'edited')
    if (action.kind !== 'updateBoard') throw new Error('unreachable')
    const untouched = action.board.nodes.find((node) => node.id === 'c1')
    expect(untouched).toBe(noteNode)
  })
})
