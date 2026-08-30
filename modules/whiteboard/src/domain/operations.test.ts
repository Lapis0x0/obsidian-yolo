import {
  type Board,
  type BoardCard,
  type Edge,
  type TextCard,
  emptyBoard,
} from './fileFormat'
import {
  type CardPatch,
  addCard,
  addEdge,
  moveCard,
  removeCard,
  removeEdge,
  replaceCard,
  updateCard,
} from './operations'

function textCard(
  id: string,
  overrides: Partial<Omit<TextCard, 'id' | 'type'>> = {},
): TextCard {
  return {
    id,
    type: 'text',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    markdown: '',
    extra: {},
    ...overrides,
  }
}

function edge(
  id: string,
  from: string,
  to: string,
  overrides: Partial<Edge> = {},
): Edge {
  return { id, from, to, arrow: 'end', extra: {}, ...overrides }
}

function boardWith(cards: BoardCard[], edges: Edge[] = []): Board {
  return { ...emptyBoard(), cards, edges }
}

describe('addCard', () => {
  it('appends the card and keeps other cards referentially unchanged', () => {
    const c1 = textCard('c1')
    const board = boardWith([c1])
    const next = addCard(board, textCard('c2'))
    expect(next.cards).toHaveLength(2)
    expect(next.cards[0]).toBe(c1)
    expect(next).not.toBe(board)
  })

  it('throws on a duplicate id', () => {
    const board = boardWith([textCard('c1')])
    expect(() => addCard(board, textCard('c1'))).toThrow(/duplicate/i)
  })

  it('throws on an empty id', () => {
    const board = boardWith([])
    expect(() => addCard(board, textCard(''))).toThrow()
  })
})

describe('updateCard', () => {
  it('patches only the target card, leaving siblings referentially unchanged', () => {
    const c1 = textCard('c1', { markdown: 'old' })
    const c2 = textCard('c2')
    const board = boardWith([c1, c2])
    const next = updateCard(board, 'c1', { markdown: 'new' })
    expect(next.cards[1]).toBe(c2)
    expect(next.cards[0]).not.toBe(c1)
    expect((next.cards[0] as { markdown: string }).markdown).toBe('new')
  })

  it('returns the same board reference when the patch changes nothing', () => {
    const c1 = textCard('c1', { markdown: 'same' })
    const board = boardWith([c1])
    const next = updateCard(board, 'c1', { markdown: 'same' })
    expect(next).toBe(board)
  })

  it('throws for an unknown card id', () => {
    const board = boardWith([textCard('c1')])
    expect(() => updateCard(board, 'missing', { x: 1 })).toThrow(/not found/i)
  })

  it('rejects a patch that tries to change "id" or "type"', () => {
    const board = boardWith([textCard('c1')])
    expect(() =>
      updateCard(board, 'c1', { id: 'c2' } as unknown as CardPatch),
    ).toThrow(/id.*type|type.*id/i)
    expect(() =>
      updateCard(board, 'c1', { type: 'note' } as unknown as CardPatch),
    ).toThrow(/id.*type|type.*id/i)
  })
})

describe('replaceCard', () => {
  it('swaps the card in place and leaves its edges intact', () => {
    const c1 = textCard('c1')
    const c2 = textCard('c2')
    const wire = edge('e1', 'c1', 'c2')
    const board = boardWith([c1, c2], [wire])

    const promoted: BoardCard = {
      id: 'c1',
      type: 'note',
      x: c1.x,
      y: c1.y,
      w: c1.w,
      h: c1.h,
      file: 'Board Cards/Untitled.md',
      extra: {},
    }
    const next = replaceCard(board, 'c1', promoted)

    expect(next.cards[0]).toBe(promoted)
    expect(next.cards[1]).toBe(c2)
    // The reason this primitive exists: remove-then-add would drop this.
    expect(next.edges).toBe(board.edges)
  })

  it('returns the same board when the replacement is identical', () => {
    const c1 = textCard('c1')
    const board = boardWith([c1])
    expect(replaceCard(board, 'c1', { ...c1 })).toBe(board)
  })

  it('refuses to change the id or replace a card that is not there', () => {
    const board = boardWith([textCard('c1')])
    expect(() => replaceCard(board, 'c1', textCard('c2'))).toThrow('must equal')
    expect(() => replaceCard(board, 'missing', textCard('missing'))).toThrow(
      'not found',
    )
  })
})

describe('removeCard', () => {
  it('removes the card and cascades incident edges', () => {
    const c1 = textCard('c1')
    const c2 = textCard('c2')
    const c3 = textCard('c3')
    const e1 = edge('e1', 'c1', 'c2')
    const e2 = edge('e2', 'c2', 'c3')
    const board = boardWith([c1, c2, c3], [e1, e2])
    const next = removeCard(board, 'c1')
    expect(next.cards.map((c) => c.id)).toEqual(['c2', 'c3'])
    expect(next.edges).toEqual([e2])
    expect(next.edges[0]).toBe(e2)
  })

  it('keeps the same edges array reference when no edge is incident', () => {
    const c1 = textCard('c1')
    const c2 = textCard('c2')
    const c3 = textCard('c3')
    const e1 = edge('e1', 'c2', 'c3')
    const board = boardWith([c1, c2, c3], [e1])
    const next = removeCard(board, 'c1')
    expect(next.edges).toBe(board.edges)
  })

  it('throws for an unknown card id', () => {
    const board = boardWith([textCard('c1')])
    expect(() => removeCard(board, 'missing')).toThrow(/not found/i)
  })
})

describe('moveCard', () => {
  it('moves the given cards by (dx, dy), leaving others referentially unchanged', () => {
    const c1 = textCard('c1', { x: 0, y: 0 })
    const c2 = textCard('c2', { x: 10, y: 10 })
    const board = boardWith([c1, c2])
    const next = moveCard(board, ['c1'], 5, -5)
    expect(next.cards[0]).toMatchObject({ x: 5, y: -5 })
    expect(next.cards[1]).toBe(c2)
  })

  it('supports batch multi-card moves', () => {
    const c1 = textCard('c1', { x: 0, y: 0 })
    const c2 = textCard('c2', { x: 10, y: 10 })
    const board = boardWith([c1, c2])
    const next = moveCard(board, ['c1', 'c2'], 1, 2)
    expect(next.cards[0]).toMatchObject({ x: 1, y: 2 })
    expect(next.cards[1]).toMatchObject({ x: 11, y: 12 })
  })

  it('is a no-op (same reference) for an empty id list or zero delta', () => {
    const board = boardWith([textCard('c1')])
    expect(moveCard(board, [], 5, 5)).toBe(board)
    expect(moveCard(board, ['c1'], 0, 0)).toBe(board)
  })

  it('throws for an unknown card id', () => {
    const board = boardWith([textCard('c1')])
    expect(() => moveCard(board, ['missing'], 1, 1)).toThrow(/not found/i)
  })
})

describe('addEdge', () => {
  it('appends the edge when both endpoints exist', () => {
    const board = boardWith([textCard('c1'), textCard('c2')])
    const next = addEdge(board, edge('e1', 'c1', 'c2'))
    expect(next.edges).toHaveLength(1)
  })

  it('throws on a duplicate edge id', () => {
    const board = boardWith(
      [textCard('c1'), textCard('c2')],
      [edge('e1', 'c1', 'c2')],
    )
    expect(() => addEdge(board, edge('e1', 'c1', 'c2'))).toThrow(/duplicate/i)
  })

  it('throws when an endpoint card does not exist', () => {
    const board = boardWith([textCard('c1')])
    expect(() => addEdge(board, edge('e1', 'c1', 'missing'))).toThrow(
      /not found/i,
    )
  })
})

describe('removeEdge', () => {
  it('removes the edge, keeping other edges referentially unchanged', () => {
    const e1 = edge('e1', 'c1', 'c2')
    const e2 = edge('e2', 'c2', 'c3')
    const board = boardWith(
      [textCard('c1'), textCard('c2'), textCard('c3')],
      [e1, e2],
    )
    const next = removeEdge(board, 'e1')
    expect(next.edges).toEqual([e2])
    expect(next.edges[0]).toBe(e2)
  })

  it('throws for an unknown edge id', () => {
    const board = boardWith([textCard('c1')])
    expect(() => removeEdge(board, 'missing')).toThrow(/not found/i)
  })
})
