import { type BoardEditContext, applyBoardEdit } from './edit'
import { type Board, type BoardNode, emptyBoard } from './fileFormat'

function card(id: string, x: number, y: number, text = ''): BoardNode {
  return { id, type: 'text', x, y, w: 100, h: 100, text, extra: {} }
}

function boardWith(nodes: BoardNode[]): Board {
  return { ...emptyBoard(), nodes }
}

function contextWith(): BoardEditContext {
  let cards = 0
  let edges = 0
  return {
    // Deterministic, so a test can name the id an operation just created.
    newNodeId: () => `c-${(cards += 1)}`,
    newEdgeId: () => `e-${(edges += 1)}`,
    gridStep: 20,
    textCardSize: { w: 260, h: 182 },
    embedCardSize: { w: 390, h: 390 },
  }
}

function apply(board: Board, edit: Parameters<typeof applyBoardEdit>[1]) {
  return applyBoardEdit(board, edit, contextWith())
}

function ok(result: ReturnType<typeof applyBoardEdit>) {
  if (!result.ok) throw new Error(`expected success, got: ${result.error}`)
  return result
}

describe('applyBoardEdit — create', () => {
  it('places a card on an empty board at the origin', () => {
    const result = ok(apply(emptyBoard(), { create: [{ text: 'hello' }] }))
    expect(result.createdCardIds).toEqual(['c-1'])
    expect(result.board.nodes[0]).toMatchObject({
      type: 'text',
      text: 'hello',
      x: 0,
      y: 0,
      w: 260,
      h: 182,
    })
  })

  it('honours explicit coordinates without searching', () => {
    // Right on top of an existing card: the model said where, and second-
    // guessing it would make the coordinates it reads back untrustworthy.
    const board = boardWith([card('c-old', 0, 0)])
    const result = ok(apply(board, { create: [{ text: 'a', x: 0, y: 0 }] }))
    expect(result.board.nodes[1]).toMatchObject({ x: 0, y: 0 })
  })

  it('rejects x without y', () => {
    const result = apply(emptyBoard(), { create: [{ text: 'a', x: 10 }] })
    expect(result).toMatchObject({ ok: false })
  })

  it('flows a batch off each other rather than stacking them', () => {
    const result = ok(
      apply(emptyBoard(), {
        create: [{ text: 'a' }, { text: 'b' }, { text: 'c' }],
      }),
    )
    const xs = result.board.nodes.map((node) => node.x)
    expect(xs[0]).toBeLessThan(xs[1])
    expect(xs[1]).toBeLessThan(xs[2])
    expect(new Set(result.board.nodes.map((node) => node.y)).size).toBe(1)
  })

  it('never moves a card that is already there', () => {
    const board = boardWith([card('c-old', 0, 0)])
    const result = ok(apply(board, { create: [{ text: 'a' }] }))
    expect(result.board.nodes[0]).toBe(board.nodes[0])
  })

  it('places relative to a named anchor', () => {
    const board = boardWith([card('c-a', 0, 0), card('c-b', 1000, 1000)])
    const result = ok(
      apply(board, {
        create: [{ text: 'x', anchor: 'c-b', direction: 'below' }],
      }),
    )
    expect(result.board.nodes[2]).toMatchObject({ x: 1000 })
    expect(result.board.nodes[2].y).toBeGreaterThan(1000)
  })

  it('rejects a card that is neither text, file nor url', () => {
    expect(apply(emptyBoard(), { create: [{}] })).toMatchObject({ ok: false })
  })

  it('rejects a card that is two kinds at once', () => {
    const result = apply(emptyBoard(), {
      create: [{ text: 'a', url: 'https://example.com' }],
    })
    expect(result).toMatchObject({ ok: false })
  })

  it('gives an embedded card the embed size', () => {
    const result = ok(apply(emptyBoard(), { create: [{ file: 'note.md' }] }))
    expect(result.board.nodes[0]).toMatchObject({ w: 390, h: 390 })
  })
})

describe('applyBoardEdit — colour', () => {
  it('accepts a colour by name', () => {
    const result = ok(
      apply(emptyBoard(), { create: [{ text: 'a', color: 'purple' }] }),
    )
    expect(result.board.nodes[0].color).toBe('6')
  })

  it('accepts a hex colour', () => {
    const result = ok(
      apply(emptyBoard(), { create: [{ text: 'a', color: '#abc' }] }),
    )
    expect(result.board.nodes[0].color).toBe('#abc')
  })

  it('rejects a colour nothing would render, rather than writing it through', () => {
    const result = apply(emptyBoard(), {
      create: [{ text: 'a', color: 'light blue' }],
    })
    expect(result).toMatchObject({ ok: false })
  })
})

describe('applyBoardEdit — delete', () => {
  it('removes a card and the connections attached to it', () => {
    const board: Board = {
      ...emptyBoard(),
      nodes: [card('c-a', 0, 0), card('c-b', 200, 0)],
      edges: [
        {
          id: 'e-1',
          fromNode: 'c-a',
          toNode: 'c-b',
          fromEnd: 'none',
          toEnd: 'arrow',
          extra: {},
        },
      ],
    }
    const result = ok(apply(board, { delete: ['c-a'] }))
    expect(result.board.nodes.map((node) => node.id)).toEqual(['c-b'])
    expect(result.board.edges).toEqual([])
  })

  it('takes a connection id in the same list', () => {
    const board: Board = {
      ...emptyBoard(),
      nodes: [card('c-a', 0, 0), card('c-b', 200, 0)],
      edges: [
        {
          id: 'e-1',
          fromNode: 'c-a',
          toNode: 'c-b',
          fromEnd: 'none',
          toEnd: 'arrow',
          extra: {},
        },
      ],
    }
    const result = ok(apply(board, { delete: ['e-1'] }))
    expect(result.board.nodes).toHaveLength(2)
    expect(result.board.edges).toEqual([])
  })

  it('rejects an unknown id', () => {
    expect(apply(emptyBoard(), { delete: ['c-nope'] })).toMatchObject({
      ok: false,
    })
  })
})

describe('applyBoardEdit — update', () => {
  it('changes a text card and leaves the rest alone', () => {
    const board = boardWith([card('c-a', 0, 0, 'before')])
    const result = ok(apply(board, { update: [{ id: 'c-a', text: 'after' }] }))
    expect(result.board.nodes[0]).toMatchObject({ text: 'after', x: 0, y: 0 })
  })

  it('refuses to set text on a card that has none', () => {
    const board = boardWith([
      {
        id: 'c-f',
        type: 'file',
        x: 0,
        y: 0,
        w: 10,
        h: 10,
        file: 'n.md',
        extra: {},
      },
    ])
    // Silently ignoring it would report a success the board does not reflect.
    expect(apply(board, { update: [{ id: 'c-f', text: 'x' }] })).toMatchObject({
      ok: false,
    })
  })

  it('relabels a connection', () => {
    const board: Board = {
      ...emptyBoard(),
      nodes: [card('c-a', 0, 0), card('c-b', 200, 0)],
      edges: [
        {
          id: 'e-1',
          fromNode: 'c-a',
          toNode: 'c-b',
          fromEnd: 'none',
          toEnd: 'arrow',
          extra: {},
        },
      ],
    }
    const result = ok(apply(board, { update: [{ id: 'e-1', label: 'why' }] }))
    expect(result.board.edges[0].label).toBe('why')
  })

  it('refuses to move a connection', () => {
    const board: Board = {
      ...emptyBoard(),
      nodes: [card('c-a', 0, 0), card('c-b', 200, 0)],
      edges: [
        {
          id: 'e-1',
          fromNode: 'c-a',
          toNode: 'c-b',
          fromEnd: 'none',
          toEnd: 'arrow',
          extra: {},
        },
      ],
    }
    expect(apply(board, { update: [{ id: 'e-1', x: 5 }] })).toMatchObject({
      ok: false,
    })
  })
})

describe('applyBoardEdit — connect and group', () => {
  it('connects two cards created in the same call', () => {
    const result = ok(
      apply(emptyBoard(), {
        create: [{ text: 'a' }, { text: 'b' }],
        connect: [{ from: 'c-1', to: 'c-2', label: 'leads to' }],
      }),
    )
    expect(result.createdEdgeIds).toEqual(['e-1'])
    expect(result.board.edges[0]).toMatchObject({
      fromNode: 'c-1',
      toNode: 'c-2',
      label: 'leads to',
      fromEnd: 'none',
      toEnd: 'arrow',
    })
  })

  it('rejects a connection to a card that does not exist', () => {
    const board = boardWith([card('c-a', 0, 0)])
    expect(
      apply(board, { connect: [{ from: 'c-a', to: 'c-gone' }] }),
    ).toMatchObject({ ok: false })
  })

  it('rejects a self-connection', () => {
    const board = boardWith([card('c-a', 0, 0)])
    expect(
      apply(board, { connect: [{ from: 'c-a', to: 'c-a' }] }),
    ).toMatchObject({ ok: false })
  })

  it('frames the cards it groups, behind them', () => {
    const board = boardWith([card('c-a', 0, 0), card('c-b', 200, 0)])
    const result = ok(
      apply(board, { group: [{ ids: ['c-a', 'c-b'], label: 'g' }] }),
    )
    const frame = result.board.nodes[0]
    expect(frame).toMatchObject({ type: 'group', label: 'g' })
    expect(frame.x).toBeLessThan(0)
    expect(frame.x + frame.w).toBeGreaterThan(300)
    expect(result.createdGroupIds).toEqual([frame.id])
  })
})

describe('applyBoardEdit — arrange', () => {
  it('aligns the cards it is given', () => {
    const board = boardWith([card('c-a', 0, 0), card('c-b', 40, 300)])
    const result = ok(
      apply(board, { arrange: [{ ids: ['c-a', 'c-b'], action: 'left' }] }),
    )
    expect(result.board.nodes.map((node) => node.x)).toEqual([0, 0])
  })

  it('rejects fewer than two cards', () => {
    const board = boardWith([card('c-a', 0, 0)])
    expect(
      apply(board, { arrange: [{ ids: ['c-a'], action: 'left' }] }),
    ).toMatchObject({ ok: false })
  })

  it('rejects an action nothing knows how to do', () => {
    const board = boardWith([card('c-a', 0, 0), card('c-b', 40, 300)])
    const result = apply(board, {
      arrange: [
        { ids: ['c-a', 'c-b'], action: 'diagonal' as unknown as 'left' },
      ],
    })
    expect(result).toMatchObject({ ok: false })
  })
})

describe('applyBoardEdit — atomicity', () => {
  it('leaves the board untouched when a later operation is invalid', () => {
    const board = boardWith([card('c-a', 0, 0)])
    const result = apply(board, {
      create: [{ text: 'new' }],
      connect: [{ from: 'c-1', to: 'c-gone' }],
    })
    expect(result).toMatchObject({ ok: false })
    // The caller gets no board at all, so there is nothing half-applied to
    // write back.
    expect('board' in result).toBe(false)
  })

  it('runs the stages in their fixed order, not the order they were written', () => {
    const board = boardWith([card('c-a', 0, 0)])
    const result = ok(
      apply(board, {
        // Written arrange-first, but the card it arranges is created below.
        arrange: [{ ids: ['c-a', 'c-1'], action: 'left' }],
        create: [{ text: 'b' }],
      }),
    )
    expect(result.board.nodes.map((node) => node.x)).toEqual([0, 0])
  })
})
