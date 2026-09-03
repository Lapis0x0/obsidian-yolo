import { type Board, type BoardNode, emptyBoard } from './fileFormat'
import { mintEdgeId, mintNodeId } from './ids'

function card(id: string): BoardNode {
  return { id, type: 'text', x: 0, y: 0, w: 10, h: 10, text: '', extra: {} }
}

function boardWith(ids: string[]): Board {
  return { ...emptyBoard(), nodes: ids.map(card) }
}

describe('mintNodeId', () => {
  it('is short — four hex digits behind a prefix', () => {
    expect(mintNodeId(emptyBoard())).toMatch(/^c-[0-9a-f]{4}$/)
  })

  it('never repeats an id the board already has, and lengthens rather than spinning', () => {
    // Randomness pinned so every candidate of a given length is the same
    // one: the only way out is to notice the collision and grow.
    const random = jest.spyOn(Math, 'random').mockReturnValue(0)
    try {
      expect(mintNodeId(boardWith(['c-0000']))).toBe('c-00000')
    } finally {
      random.mockRestore()
    }
  })

  it('gives two cards on the same board different ids', () => {
    const first = mintNodeId(emptyBoard())
    const second = mintNodeId(boardWith([first]))
    expect(second).not.toBe(first)
  })

  it('draws from the node ids, not the edge ids', () => {
    const board: Board = {
      ...emptyBoard(),
      edges: [
        {
          id: 'e-1234',
          fromNode: 'c-a',
          toNode: 'c-b',
          fromEnd: 'none',
          toEnd: 'arrow',
          extra: {},
        },
      ],
    }
    expect(mintEdgeId(board)).not.toBe('e-1234')
    expect(mintNodeId(board)).toMatch(/^c-/)
  })
})
