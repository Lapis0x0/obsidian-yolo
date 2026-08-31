import { type CanvasImportResult, importCanvas } from './canvasImport'
import { type Board, parseBoard, serializeBoard } from './fileFormat'

/** A canvas exercising every node kind, both edge ends, side anchors,
 * colours and a label — the shape the manual test fixture takes too. */
const SAMPLE_CANVAS = JSON.stringify({
  nodes: [
    {
      id: 'n-text',
      type: 'text',
      x: -100,
      y: -200,
      width: 250,
      height: 60,
      color: '3',
      text: '# Heading\nbody',
    },
    {
      id: 'n-file',
      type: 'file',
      x: 300,
      y: -200,
      width: 400,
      height: 400,
      file: 'Notes/Concept.md',
      subpath: '#Section',
    },
    {
      id: 'n-link',
      type: 'link',
      x: 0,
      y: 200,
      width: 300,
      height: 150,
      url: 'https://example.com/a',
    },
    {
      id: 'n-group',
      type: 'group',
      x: -200,
      y: -300,
      width: 1000,
      height: 900,
      label: 'Cluster',
      background: 'Assets/bg.png',
      backgroundStyle: 'cover',
    },
  ],
  edges: [
    {
      id: 'e-1',
      fromNode: 'n-text',
      fromSide: 'right',
      fromEnd: 'arrow',
      toNode: 'n-file',
      toSide: 'left',
      toEnd: 'arrow',
      color: '#FF0000',
      label: 'relates to',
    },
    { id: 'e-2', fromNode: 'n-file', toNode: 'n-group' },
  ],
})

function requireOk(result: CanvasImportResult): Board {
  if (!result.ok) {
    throw new Error(`expected ok, got issues: ${JSON.stringify(result.issues)}`)
  }
  return result.board
}

describe('importCanvas', () => {
  it('maps every node kind, with geometry and colour carried across', () => {
    const result = importCanvas(SAMPLE_CANVAS)
    const board = requireOk(result)
    expect(result.ok && result.issues).toEqual([])
    expect(board.nodes).toHaveLength(4)

    expect(board.nodes[0]).toMatchObject({
      id: 'n-text',
      type: 'text',
      x: -100,
      y: -200,
      w: 250,
      h: 60,
      color: '3',
      text: '# Heading\nbody',
    })
    expect(board.nodes[1]).toMatchObject({
      id: 'n-file',
      type: 'file',
      file: 'Notes/Concept.md',
    })
    expect(board.nodes[3]).toMatchObject({
      id: 'n-group',
      type: 'group',
      label: 'Cluster',
      w: 1000,
      h: 900,
    })
  })

  it('degrades a link node to a text node holding the URL as an autolink', () => {
    const board = requireOk(importCanvas(SAMPLE_CANVAS))
    expect(board.nodes[2]).toMatchObject({
      id: 'n-link',
      type: 'text',
      text: '<https://example.com/a>',
    })
  })

  it('preserves the Canvas fields we do not render yet, verbatim', () => {
    const board = requireOk(importCanvas(SAMPLE_CANVAS))
    expect(board.nodes[1].extra).toEqual({ subpath: '#Section' })
    expect(board.nodes[3].extra).toEqual({
      background: 'Assets/bg.png',
      backgroundStyle: 'cover',
    })
  })

  it('maps edges identically, applying the spec defaults for omitted ends', () => {
    const board = requireOk(importCanvas(SAMPLE_CANVAS))
    expect(board.edges[0]).toMatchObject({
      id: 'e-1',
      fromNode: 'n-text',
      toNode: 'n-file',
      fromSide: 'right',
      toSide: 'left',
      fromEnd: 'arrow',
      toEnd: 'arrow',
      color: '#FF0000',
      label: 'relates to',
    })
    expect(board.edges[1]).toMatchObject({
      id: 'e-2',
      fromNode: 'n-file',
      // An edge may end on a group; nothing here treats that as special.
      toNode: 'n-group',
      fromEnd: 'none',
      toEnd: 'arrow',
      fromSide: undefined,
      toSide: undefined,
    })
  })

  it('reuses the canvas ids, so edges keep pointing at the same nodes', () => {
    const board = requireOk(importCanvas(SAMPLE_CANVAS))
    expect(board.nodes.map((node) => node.id)).toEqual([
      'n-text',
      'n-file',
      'n-link',
      'n-group',
    ])
  })

  it('produces a board that parses back through the .yoloboard reader', () => {
    const board = requireOk(importCanvas(SAMPLE_CANVAS))
    const reparsed = parseBoard(serializeBoard(board))
    expect(reparsed.ok).toBe(true)
    expect(reparsed.ok && reparsed.issues).toEqual([])
    expect(reparsed.ok && reparsed.board.nodes).toHaveLength(4)
    expect(reparsed.ok && reparsed.board.edges).toHaveLength(2)
  })

  it('parks the camera on the content, so an off-origin canvas does not open empty', () => {
    const board = requireOk(importCanvas(SAMPLE_CANVAS))
    // The top-left node sits at (-200, -300); the world layer is translated
    // so that corner lands just inside the viewport.
    expect(board.camera).toEqual({ x: 248, y: 348, scale: 1 })
  })

  it('leaves the camera at the origin for an empty canvas', () => {
    const board = requireOk(
      importCanvas(JSON.stringify({ nodes: [], edges: [] })),
    )
    expect(board.camera).toEqual({ x: 0, y: 0, scale: 1 })
    expect(board.nodes).toEqual([])
  })

  it('fails on unparsable JSON and on a non-object root', () => {
    expect(importCanvas('{nope').ok).toBe(false)
    expect(importCanvas('[]').ok).toBe(false)
  })

  it('skips an unusable node and reports it, keeping the rest', () => {
    const raw = JSON.stringify({
      nodes: [
        {
          id: 'a',
          type: 'text',
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          text: 'kept',
        },
        {
          id: 'b',
          type: 'text',
          x: 0,
          y: 0,
          width: 'wide',
          height: 10,
          text: 'x',
        },
        { id: 'c', type: 'unknown-kind', x: 0, y: 0, width: 10, height: 10 },
        {
          id: 'a',
          type: 'text',
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          text: 'dupe',
        },
      ],
    })
    const result = importCanvas(raw)
    const board = requireOk(result)
    expect(board.nodes.map((node) => node.id)).toEqual(['a'])
    expect(result.ok && result.issues).toHaveLength(3)
  })

  it('drops an edge whose endpoint node was skipped, so the board stays readable', () => {
    const raw = JSON.stringify({
      nodes: [
        { id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: '' },
        {
          id: 'b',
          type: 'text',
          x: 0,
          y: 0,
          width: null,
          height: 10,
          text: '',
        },
      ],
      edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
    })
    const result = importCanvas(raw)
    const board = requireOk(result)
    expect(board.edges).toEqual([])
    expect(
      result.ok && result.issues.some((issue) => issue.type === 'skipped-edge'),
    ).toBe(true)
    // The whole point of dropping it: a dangling edge would make the written
    // file unreadable by parseBoard.
    const reparsed = parseBoard(serializeBoard(board))
    expect(reparsed.ok && reparsed.issues).toEqual([])
  })

  it('reports counts of what actually landed', () => {
    const result = importCanvas(SAMPLE_CANVAS)
    expect(result.ok && result.counts).toEqual({ nodes: 4, edges: 2 })
  })
})
