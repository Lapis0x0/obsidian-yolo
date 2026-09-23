import {
  fragmentFromSelection,
  fragmentPlainText,
  parseFragment,
  placeFragment,
  serializeFragment,
} from './clipboard'
import {
  type Board,
  type BoardNode,
  type Edge,
  type TextNode,
  emptyBoard,
} from './fileFormat'

function text(id: string, x: number, y: number, body = ''): TextNode {
  return { id, type: 'text', x, y, w: 100, h: 50, text: body, extra: {} }
}

function group(id: string, x: number, y: number, w: number, h: number) {
  return { id, type: 'group', x, y, w, h, extra: {} } as const
}

function edge(id: string, fromNode: string, toNode: string): Edge {
  return { id, fromNode, toNode, fromEnd: 'none', toEnd: 'arrow', extra: {} }
}

function board(nodes: BoardNode[], edges: Edge[] = []): Board {
  return { ...emptyBoard(), nodes, edges }
}

describe('fragmentFromSelection', () => {
  it('takes a selected group with what it frames, in board order', () => {
    const b = board([
      text('a', 10, 10),
      group('g', 0, 0, 300, 300),
      text('outside', 500, 500),
    ])
    const fragment = fragmentFromSelection(b, new Set(['g']))
    expect(fragment.nodes.map((node) => node.id)).toEqual(['a', 'g'])
  })

  it('keeps only edges whose two ends are both taken', () => {
    const b = board(
      [text('a', 0, 0), text('b', 200, 0), text('c', 400, 0)],
      [edge('ab', 'a', 'b'), edge('bc', 'b', 'c')],
    )
    const fragment = fragmentFromSelection(b, new Set(['a', 'b']))
    expect(fragment.edges.map((e) => e.id)).toEqual(['ab'])
  })
})

describe('serializeFragment / parseFragment', () => {
  it('writes JSON Canvas geometry and a centre, and reads it back', () => {
    const nodes: BoardNode[] = [
      { ...text('a', 0, 0, 'hi'), startLine: 3, color: '2' },
      text('b', 200, 100),
    ]
    const fragment = { nodes, edges: [edge('ab', 'a', 'b')] }
    const raw = serializeFragment(fragment)
    const json = JSON.parse(raw)
    expect(json.nodes[0]).toMatchObject({ width: 100, height: 50 })
    expect(json.nodes[0].w).toBeUndefined()
    expect(json.center).toEqual({ x: 150, y: 75 })
    expect(parseFragment(raw)).toEqual(fragment)
  })

  it('reads what Obsidian Canvas writes, keeping fields it does not know', () => {
    const raw = JSON.stringify({
      nodes: [
        {
          id: 'n1',
          type: 'file',
          file: 'Note.md',
          subpath: '#Heading',
          x: 0,
          y: 0,
          width: 400,
          height: 300,
        },
      ],
      edges: [],
      center: { x: 200, y: 150 },
    })
    expect(parseFragment(raw)?.nodes).toEqual([
      {
        id: 'n1',
        type: 'file',
        file: 'Note.md',
        x: 0,
        y: 0,
        w: 400,
        h: 300,
        extra: { subpath: '#Heading' },
      },
    ])
  })

  it('drops what does not parse, and gives up when no node survives', () => {
    expect(parseFragment('not json')).toBeNull()
    expect(parseFragment('{"nodes":[{"id":"x","type":"text"}]}')).toBeNull()
    const raw = JSON.stringify({
      nodes: [
        { id: 'a', type: 'text', text: '', x: 0, y: 0, width: 1, height: 1 },
      ],
      edges: [edge('dangling', 'a', 'missing')],
    })
    expect(parseFragment(raw)?.edges).toEqual([])
  })
})

describe('fragmentPlainText', () => {
  it('is the text cards, one paragraph each', () => {
    const fragment = {
      nodes: [
        text('a', 0, 0, 'one'),
        group('g', 0, 0, 1, 1),
        text('b', 0, 0, 'two'),
      ],
      edges: [],
    }
    expect(fragmentPlainText(fragment)).toBe('one\n\ntwo')
  })
})

describe('placeFragment', () => {
  it('centres a copy on the point with fresh ids and rewired edges', () => {
    const existing = board([text('a', 0, 0)])
    const fragment = {
      nodes: [text('a', 0, 0), text('b', 200, 100)],
      edges: [edge('ab', 'a', 'b')],
    }
    const { board: next, nodeIds } = placeFragment(existing, fragment, {
      x: 1000,
      y: 1000,
    })
    expect(nodeIds).toHaveLength(2)
    expect(nodeIds).not.toContain('a')
    const placed = nodeIds.map((id) => next.nodes.find((n) => n.id === id))
    // The fragment spans (0,0)-(300,150): its centre (150,75) lands on the point.
    expect(placed.map((n) => [n?.x, n?.y])).toEqual([
      [850, 925],
      [1050, 1025],
    ])
    expect(next.edges).toHaveLength(1)
    expect(next.edges[0]).toMatchObject({
      fromNode: nodeIds[0],
      toNode: nodeIds[1],
    })
    expect(next.edges[0].id).not.toBe('ab')
  })
})
