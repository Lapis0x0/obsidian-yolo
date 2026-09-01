import {
  type Board,
  type BoardNode,
  type Edge,
  type TextNode,
  emptyBoard,
} from './fileFormat'
import {
  type NodePatch,
  addEdge,
  addNode,
  boardWithReadingWindow,
  moveNodes,
  removeEdge,
  removeNode,
  replaceNode,
  setNodePositions,
  updateEdge,
  updateNode,
} from './operations'

function textCard(
  id: string,
  overrides: Partial<Omit<TextNode, 'id' | 'type'>> = {},
): TextNode {
  return {
    id,
    type: 'text',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    text: '',
    extra: {},
    ...overrides,
  }
}

function edge(
  id: string,
  fromNode: string,
  toNode: string,
  overrides: Partial<Edge> = {},
): Edge {
  return {
    id,
    fromNode,
    toNode,
    fromEnd: 'none',
    toEnd: 'arrow',
    extra: {},
    ...overrides,
  }
}

function boardWith(nodes: BoardNode[], edges: Edge[] = []): Board {
  return { ...emptyBoard(), nodes, edges }
}

describe('addNode', () => {
  it('appends the card and keeps other cards referentially unchanged', () => {
    const c1 = textCard('c1')
    const board = boardWith([c1])
    const next = addNode(board, textCard('c2'))
    expect(next.nodes).toHaveLength(2)
    expect(next.nodes[0]).toBe(c1)
    expect(next).not.toBe(board)
  })

  it('throws on a duplicate id', () => {
    const board = boardWith([textCard('c1')])
    expect(() => addNode(board, textCard('c1'))).toThrow(/duplicate/i)
  })

  it('throws on an empty id', () => {
    const board = boardWith([])
    expect(() => addNode(board, textCard(''))).toThrow()
  })
})

describe('updateNode', () => {
  it('patches only the target card, leaving siblings referentially unchanged', () => {
    const c1 = textCard('c1', { text: 'old' })
    const c2 = textCard('c2')
    const board = boardWith([c1, c2])
    const next = updateNode(board, 'c1', { text: 'new' })
    expect(next.nodes[1]).toBe(c2)
    expect(next.nodes[0]).not.toBe(c1)
    expect((next.nodes[0] as { text: string }).text).toBe('new')
  })

  it('returns the same board reference when the patch changes nothing', () => {
    const c1 = textCard('c1', { text: 'same' })
    const board = boardWith([c1])
    const next = updateNode(board, 'c1', { text: 'same' })
    expect(next).toBe(board)
  })

  it('throws for an unknown card id', () => {
    const board = boardWith([textCard('c1')])
    expect(() => updateNode(board, 'missing', { x: 1 })).toThrow(/not found/i)
  })

  it('rejects a patch that tries to change "id" or "type"', () => {
    const board = boardWith([textCard('c1')])
    expect(() =>
      updateNode(board, 'c1', { id: 'c2' } as unknown as NodePatch),
    ).toThrow(/id.*type|type.*id/i)
    expect(() =>
      updateNode(board, 'c1', { type: 'file' } as unknown as NodePatch),
    ).toThrow(/id.*type|type.*id/i)
  })
})

describe('replaceNode', () => {
  it('swaps the card in place and leaves its edges intact', () => {
    const c1 = textCard('c1')
    const c2 = textCard('c2')
    const wire = edge('e1', 'c1', 'c2')
    const board = boardWith([c1, c2], [wire])

    const promoted: BoardNode = {
      id: 'c1',
      type: 'file',
      x: c1.x,
      y: c1.y,
      w: c1.w,
      h: c1.h,
      file: 'Board Cards/Untitled.md',
      extra: {},
    }
    const next = replaceNode(board, 'c1', promoted)

    expect(next.nodes[0]).toBe(promoted)
    expect(next.nodes[1]).toBe(c2)
    // The reason this primitive exists: remove-then-add would drop this.
    expect(next.edges).toBe(board.edges)
  })

  it('returns the same board when the replacement is identical', () => {
    const c1 = textCard('c1')
    const board = boardWith([c1])
    expect(replaceNode(board, 'c1', { ...c1 })).toBe(board)
  })

  it('refuses to change the id or replace a card that is not there', () => {
    const board = boardWith([textCard('c1')])
    expect(() => replaceNode(board, 'c1', textCard('c2'))).toThrow('must equal')
    expect(() => replaceNode(board, 'missing', textCard('missing'))).toThrow(
      'not found',
    )
  })
})

describe('removeNode', () => {
  it('removes the card and cascades incident edges', () => {
    const c1 = textCard('c1')
    const c2 = textCard('c2')
    const c3 = textCard('c3')
    const e1 = edge('e1', 'c1', 'c2')
    const e2 = edge('e2', 'c2', 'c3')
    const board = boardWith([c1, c2, c3], [e1, e2])
    const next = removeNode(board, 'c1')
    expect(next.nodes.map((c) => c.id)).toEqual(['c2', 'c3'])
    expect(next.edges).toEqual([e2])
    expect(next.edges[0]).toBe(e2)
  })

  it('keeps the same edges array reference when no edge is incident', () => {
    const c1 = textCard('c1')
    const c2 = textCard('c2')
    const c3 = textCard('c3')
    const e1 = edge('e1', 'c2', 'c3')
    const board = boardWith([c1, c2, c3], [e1])
    const next = removeNode(board, 'c1')
    expect(next.edges).toBe(board.edges)
  })

  it('throws for an unknown card id', () => {
    const board = boardWith([textCard('c1')])
    expect(() => removeNode(board, 'missing')).toThrow(/not found/i)
  })
})

describe('moveNodes', () => {
  it('moves the given cards by (dx, dy), leaving others referentially unchanged', () => {
    const c1 = textCard('c1', { x: 0, y: 0 })
    const c2 = textCard('c2', { x: 10, y: 10 })
    const board = boardWith([c1, c2])
    const next = moveNodes(board, ['c1'], 5, -5)
    expect(next.nodes[0]).toMatchObject({ x: 5, y: -5 })
    expect(next.nodes[1]).toBe(c2)
  })

  it('supports batch multi-card moves', () => {
    const c1 = textCard('c1', { x: 0, y: 0 })
    const c2 = textCard('c2', { x: 10, y: 10 })
    const board = boardWith([c1, c2])
    const next = moveNodes(board, ['c1', 'c2'], 1, 2)
    expect(next.nodes[0]).toMatchObject({ x: 1, y: 2 })
    expect(next.nodes[1]).toMatchObject({ x: 11, y: 12 })
  })

  it('is a no-op (same reference) for an empty id list or zero delta', () => {
    const board = boardWith([textCard('c1')])
    expect(moveNodes(board, [], 5, 5)).toBe(board)
    expect(moveNodes(board, ['c1'], 0, 0)).toBe(board)
  })

  it('throws for an unknown card id', () => {
    const board = boardWith([textCard('c1')])
    expect(() => moveNodes(board, ['missing'], 1, 1)).toThrow(/not found/i)
  })
})

describe('setNodePositions', () => {
  it('moves each node to its own position in one board change', () => {
    const board = boardWith([textCard('c1'), textCard('c2')])
    const next = setNodePositions(
      board,
      new Map([
        ['c1', { x: 10, y: 20 }],
        ['c2', { x: 300, y: 0 }],
      ]),
    )
    expect(next.nodes[0]).toMatchObject({ x: 10, y: 20 })
    expect(next.nodes[1]).toMatchObject({ x: 300, y: 0 })
  })

  it('keeps untouched nodes referentially identical', () => {
    const c2 = textCard('c2')
    const board = boardWith([textCard('c1'), c2])
    const next = setNodePositions(board, new Map([['c1', { x: 5, y: 5 }]]))
    expect(next.nodes[1]).toBe(c2)
  })

  it('returns the same board when nothing actually moves', () => {
    const board = boardWith([textCard('c1', { x: 7, y: 8 })])
    expect(setNodePositions(board, new Map([['c1', { x: 7, y: 8 }]]))).toBe(
      board,
    )
  })

  it('returns the same board for an empty batch', () => {
    const board = boardWith([textCard('c1')])
    expect(setNodePositions(board, new Map())).toBe(board)
  })

  it('preserves everything about a node but its position', () => {
    const board = boardWith([
      textCard('c1', { text: 'kept', color: '3', w: 42, extra: { k: 1 } }),
    ])
    const next = setNodePositions(board, new Map([['c1', { x: 1, y: 2 }]]))
    expect(next.nodes[0]).toEqual({
      id: 'c1',
      type: 'text',
      x: 1,
      y: 2,
      w: 42,
      h: 100,
      text: 'kept',
      color: '3',
      extra: { k: 1 },
    })
  })

  it('throws for an unknown node rather than silently skipping it', () => {
    const board = boardWith([textCard('c1')])
    expect(() =>
      setNodePositions(board, new Map([['missing', { x: 0, y: 0 }]])),
    ).toThrow(/not found/)
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

describe('updateEdge', () => {
  const board = boardWith(
    [textCard('c1'), textCard('c2'), textCard('c3')],
    [edge('e1', 'c1', 'c2', { fromSide: 'right', toSide: 'left' })],
  )

  it('repoints one end, leaving the other alone', () => {
    const next = updateEdge(board, 'e1', { toNode: 'c3', toSide: 'top' })
    expect(next.edges[0]).toMatchObject({
      fromNode: 'c1',
      fromSide: 'right',
      toNode: 'c3',
      toSide: 'top',
    })
  })

  it('returns the same board when the patch changes nothing', () => {
    expect(updateEdge(board, 'e1', { toNode: 'c2', toSide: 'left' })).toBe(
      board,
    )
  })

  it('patches the arrowheads independently at each end', () => {
    const next = updateEdge(board, 'e1', { fromEnd: 'arrow', toEnd: 'none' })
    expect(next.edges[0]).toMatchObject({ fromEnd: 'arrow', toEnd: 'none' })
  })

  it('patches the colour and the label', () => {
    const next = updateEdge(board, 'e1', { color: '3', label: 'depends on' })
    expect(next.edges[0]).toMatchObject({ color: '3', label: 'depends on' })
  })

  it('clears the colour and the label back to absent', () => {
    const coloured = updateEdge(board, 'e1', { color: '3', label: 'x' })
    const cleared = updateEdge(coloured, 'e1', {
      color: undefined,
      label: undefined,
    })
    expect(cleared.edges[0].color).toBeUndefined()
    expect(cleared.edges[0].label).toBeUndefined()
  })

  it('throws when the new endpoint card does not exist', () => {
    expect(() => updateEdge(board, 'e1', { toNode: 'missing' })).toThrow(
      /not found/i,
    )
  })

  it('throws for an unknown edge id', () => {
    expect(() => updateEdge(board, 'missing', { toNode: 'c3' })).toThrow(
      /not found/i,
    )
  })
})

describe('boardWithReadingWindow', () => {
  it('records where a card is being read, to two decimals', () => {
    const board = boardWith([textCard('a')])
    const next = boardWithReadingWindow(board, 'a', 119.8675595238)
    expect((next.nodes[0] as TextNode).startLine).toBe(119.87)
  })

  it('drops the field for a card back at the top', () => {
    const board = boardWith([textCard('a', { startLine: 40 })])
    const next = boardWithReadingWindow(board, 'a', 0)
    expect('startLine' in next.nodes[0]).toBe(false)
  })

  it('returns the same board when nothing moved, so nothing re-renders', () => {
    const board = boardWith([textCard('a', { startLine: 12.5 })])
    expect(boardWithReadingWindow(board, 'a', 12.5)).toBe(board)
    expect(boardWithReadingWindow(boardWith([textCard('b')]), 'b', 0)).toEqual(
      boardWith([textCard('b')]),
    )
  })

  it('ignores a node that cannot carry a window, or one that is gone', () => {
    const group: BoardNode = {
      id: 'g',
      type: 'group',
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      extra: {},
    }
    const board = boardWith([group])
    expect(boardWithReadingWindow(board, 'g', 20)).toBe(board)
    expect(boardWithReadingWindow(board, 'missing', 20)).toBe(board)
  })
})
