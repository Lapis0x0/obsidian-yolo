import {
  type Board,
  type Edge,
  type FileNode,
  type GroupNode,
  emptyBoard,
  parseBoard,
  serializeBoard,
} from './fileFormat'
import { carryGroupMembers, nodesInsideGroup, nodesToDragWith } from './groups'
import {
  SPREAD_METRICS,
  closeSpread,
  collapseBoard,
  currentSpreadColumns,
  defaultSpreadColumns,
  expandBoard,
  isSpreadTitle,
  layoutSpreadGrid,
  nodesToDelete,
  openSpread,
  pdfPageNodeId,
  reflowSpread,
  spreadColumnsForWidth,
  spreadPages,
  spreadWidthForColumns,
} from './spread'

const LETTER = { width: 612, height: 792 }

function pdf(id: string, overrides: Partial<FileNode> = {}): FileNode {
  return {
    id,
    type: 'file',
    file: 'Papers/paper.pdf',
    x: 0,
    y: 0,
    w: 390,
    h: 390,
    extra: {},
    ...overrides,
  }
}

function edge(id: string, overrides: Partial<Edge>): Edge {
  return {
    id,
    fromNode: 'a',
    toNode: 'b',
    fromEnd: 'none',
    toEnd: 'arrow',
    extra: {},
    ...overrides,
  }
}

function board(nodes: Board['nodes'], edges: Board['edges'] = []): Board {
  return { ...emptyBoard(), nodes, edges }
}

const threePages = layoutSpreadGrid(
  [LETTER, LETTER, LETTER],
  { x: 1000, y: 0 },
  2,
)

describe('layoutSpreadGrid', () => {
  it('puts the title at the origin and the sheets in rows under it', () => {
    expect(threePages.title).toEqual({
      x: 1000,
      y: 0,
      w: 390,
      h: SPREAD_METRICS.titleHeight,
    })
    const top = SPREAD_METRICS.titleHeight + SPREAD_METRICS.titleGap
    const height = Math.round((390 * 792) / 612)
    expect(threePages.pages).toEqual([
      { x: 1000, y: top, w: 390, h: height },
      { x: 1000 + 390 + 26, y: top, w: 390, h: height },
      { x: 1000, y: top + height + 26, w: 390, h: height },
    ])
  })

  it('makes a row as tall as its tallest sheet', () => {
    const layout = layoutSpreadGrid(
      [LETTER, { width: 612, height: 1584 }, LETTER],
      { x: 0, y: 0 },
      2,
    )
    expect(layout.pages[2].y - layout.pages[0].y).toBe(
      layout.pages[1].h + SPREAD_METRICS.gap,
    )
  })
})

describe('column counts', () => {
  it('lays fifteen letter pages out about square', () => {
    expect(defaultSpreadColumns(Array(15).fill(LETTER))).toBe(4)
    expect(defaultSpreadColumns([LETTER])).toBe(1)
  })

  it('snaps a width to whole columns and back', () => {
    const three = spreadWidthForColumns(3)
    expect(spreadColumnsForWidth(three)).toBe(3)
    expect(spreadColumnsForWidth(three - 1)).toBe(2)
    expect(spreadColumnsForWidth(0)).toBe(1)
  })
})

describe('openSpread / closeSpread', () => {
  it('turns the node into its title and adds a sheet per page after it', () => {
    const before = board([pdf('p', { x: 5, y: 6 }), pdf('q')])
    const open = openSpread(before, 'p', threePages)
    expect(open.nodes.map((node) => node.id)).toEqual([
      'p',
      'p/p1',
      'p/p2',
      'p/p3',
      'q',
    ])
    const title = open.nodes[0]
    expect(isSpreadTitle(title)).toBe(true)
    expect(title).toMatchObject({
      ...threePages.title,
      readerRect: { x: 5, y: 6 },
    })
    expect(open.nodes[2]).toMatchObject({
      type: 'pdf-page',
      parent: 'p',
      page: 2,
      file: 'Papers/paper.pdf',
      ...threePages.pages[1],
    })
  })

  it('moves an edge that names a page onto that sheet, and back', () => {
    const before = board(
      [pdf('p'), pdf('q')],
      [
        edge('e1', { fromNode: 'q', toNode: 'p', toPage: 2 }),
        edge('e2', { fromNode: 'p', toNode: 'q' }),
        edge('e3', { fromNode: 'p', fromPage: 9, toNode: 'q' }),
      ],
    )
    const open = openSpread(before, 'p', threePages)
    expect(open.edges[0]).toMatchObject({ toNode: pdfPageNodeId('p', 2) })
    expect(open.edges[0].toPage).toBeUndefined()
    expect(open.edges[1]).toBe(before.edges[1])
    // A page the document does not have stays on the whole PDF.
    expect(open.edges[2]).toMatchObject({ fromNode: 'p', fromPage: 9 })

    const closed = closeSpread(open, 'p')
    expect(closed.edges[0]).toMatchObject({ toNode: 'p', toPage: 2 })
  })

  it('puts the card back and remembers the layout', () => {
    const before = board([pdf('p', { x: 5, y: 6 })])
    const open = openSpread(before, 'p', threePages)
    const moved = {
      ...open,
      nodes: open.nodes.map((node) =>
        node.id === 'p/p3' ? { ...node, x: -500 } : node,
      ),
    }
    const closed = closeSpread(moved, 'p')
    expect(closed.nodes).toHaveLength(1)
    const node = closed.nodes[0] as FileNode
    expect(node).toMatchObject({ x: 5, y: 6, w: 390, h: 390 })
    expect(node.readerRect).toBeUndefined()
    expect(node.spread?.open).toBe(false)
    expect(node.spread?.pages[2].x).toBe(-500)

    // Opened again without a layout, every sheet is where it was left.
    const reopened = openSpread(closed, 'p')
    expect(reopened.nodes.find((n) => n.id === 'p/p3')?.x).toBe(-500)
  })

  it('leaves a node it cannot open alone', () => {
    const plain = board([pdf('p')])
    expect(openSpread(plain, 'p')).toBe(plain)
    expect(closeSpread(plain, 'p')).toBe(plain)
  })
})

describe('the file round trip', () => {
  it('writes an open spread as one node with the reader card rectangle', () => {
    const open = openSpread(board([pdf('p', { x: 5, y: 6 })]), 'p', threePages)
    const file = collapseBoard(open)
    expect(file.nodes).toHaveLength(1)
    const node = file.nodes[0] as FileNode
    expect(node).toMatchObject({ x: 5, y: 6 })
    expect(node.spread?.open).toBe(true)

    const text = serializeBoard(file)
    const json = JSON.parse(text) as { nodes: Record<string, unknown>[] }
    expect(json.nodes[0].spread).toEqual({
      open: true,
      title: [1000, 0, 200, SPREAD_METRICS.titleHeight],
      pages: threePages.pages.map((r) => [r.x, r.y, r.w, r.h]),
    })

    const parsed = parseBoard(text)
    if (!parsed.ok) throw new Error('parse failed')
    expect(expandBoard(parsed.board).nodes.map((n) => n.id)).toEqual([
      'p',
      'p/p1',
      'p/p2',
      'p/p3',
    ])
    expect(collapseBoard(expandBoard(parsed.board))).toEqual(parsed.board)
  })

  it('writes an edge page as a field and reads it back', () => {
    const text = serializeBoard(
      board(
        [pdf('p'), pdf('q')],
        [edge('e', { fromNode: 'p', toNode: 'q', fromPage: 3 })],
      ),
    )
    const parsed = parseBoard(text)
    if (!parsed.ok) throw new Error('parse failed')
    expect(parsed.board.edges[0].fromPage).toBe(3)
  })

  it('drops a spread it cannot trust', () => {
    const parsed = parseBoard(
      JSON.stringify({
        nodes: [
          {
            ...pdf('p'),
            extra: undefined,
            spread: { title: [0, 0, 1], pages: [] },
          },
        ],
      }),
    )
    if (!parsed.ok) throw new Error('parse failed')
    expect((parsed.board.nodes[0] as FileNode).spread).toBeUndefined()
  })

  it('refuses to write a sheet on its own', () => {
    const open = openSpread(board([pdf('p')]), 'p', threePages)
    expect(() => serializeBoard(open)).toThrow()
  })

  it('drops sheets whose title is gone', () => {
    const open = openSpread(board([pdf('p')]), 'p', threePages)
    const orphaned = { ...open, nodes: open.nodes.filter((n) => n.id !== 'p') }
    expect(collapseBoard(orphaned).nodes).toEqual([])
  })
})

describe('the document as a whole', () => {
  const open = openSpread(
    board([pdf('p'), pdf('q', { x: -2000 })]),
    'p',
    threePages,
  )

  it('deletes the sheets with their title, and never a sheet alone', () => {
    expect(nodesToDelete(open.nodes, ['p'])).toEqual([
      'p',
      'p/p1',
      'p/p2',
      'p/p3',
    ])
    expect(nodesToDelete(open.nodes, ['p/p2', 'q'])).toEqual(['q'])
  })

  it('drags the sheets with their title', () => {
    expect(nodesToDragWith(new Set(['p']), open.nodes).sort()).toEqual(
      ['p', 'p/p1', 'p/p2', 'p/p3'].sort(),
    )
    expect(nodesToDragWith(new Set(['p/p2']), open.nodes)).toEqual(['p/p2'])
  })

  it('carries the sheets when the title is moved by an arrangement', () => {
    const moves = carryGroupMembers(
      open.nodes,
      new Map([['p', { x: 1010, y: 20 }]]),
    )
    expect(moves.get('p/p3')).toEqual({
      x: threePages.pages[2].x + 10,
      y: threePages.pages[2].y + 20,
    })
  })

  it('counts a spread in a group by its title alone', () => {
    const aroundTitle: GroupNode = {
      id: 'g',
      type: 'group',
      x: 990,
      y: -10,
      w: 300,
      h: 60,
      extra: {},
    }
    expect(nodesInsideGroup(aroundTitle, open.nodes)).toEqual([
      'p',
      'p/p1',
      'p/p2',
      'p/p3',
    ])
    const aroundSheet: GroupNode = {
      ...aroundTitle,
      x: threePages.pages[0].x - 10,
      y: threePages.pages[0].y - 10,
      w: 410,
      h: 600,
    }
    expect(nodesInsideGroup(aroundSheet, open.nodes)).toEqual([])
  })
})

describe('reflowSpread', () => {
  it('lays every sheet out afresh under the title', () => {
    const open = openSpread(board([pdf('p')]), 'p', threePages)
    const scattered = {
      ...open,
      nodes: open.nodes.map((node) =>
        node.id === 'p/p2' ? { ...node, x: 9999, y: 9999 } : node,
      ),
    }
    const reflowed = reflowSpread(scattered, 'p', 3)
    const sheets = spreadPages(reflowed, 'p')
    expect(sheets.map((sheet) => sheet.y)).toEqual([
      threePages.pages[0].y,
      threePages.pages[0].y,
      threePages.pages[0].y,
    ])
    expect(currentSpreadColumns(sheets)).toBe(3)
    expect(reflowSpread(reflowed, 'p', 3)).toBe(reflowed)
  })
})
