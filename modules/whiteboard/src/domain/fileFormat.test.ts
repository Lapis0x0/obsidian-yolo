import {
  type Board,
  YOLOBOARD_SCHEMA_VERSION,
  emptyBoard,
  parseBoard,
  serializeBoard,
} from './fileFormat'

const SAMPLE_RAW = JSON.stringify({
  version: 1,
  camera: { x: 10, y: -5, scale: 1.5 },
  nodes: [
    {
      id: 'c1',
      type: 'file',
      x: 0,
      y: 0,
      w: 320,
      h: 240,
      file: 'Cards/概念A.md',
    },
    { id: 'c2', type: 'text', x: 400, y: 0, w: 240, h: 120, text: '临时便签' },
    {
      id: 'c3',
      type: 'file',
      x: 0,
      y: 400,
      w: 480,
      h: 600,
      file: 'papers/foo.pdf',
      color: '4',
    },
    { id: 'g1', type: 'group', x: -40, y: -40, w: 800, h: 800, label: '一组' },
    {
      id: 'l1',
      type: 'link',
      x: 800,
      y: 0,
      w: 400,
      h: 300,
      url: 'https://example.com/a',
    },
  ],
  edges: [
    {
      id: 'e1',
      fromNode: 'c1',
      toNode: 'c2',
      fromSide: 'right',
      toSide: 'left',
      fromEnd: 'arrow',
      toEnd: 'arrow',
      color: '#FF0000',
      label: '',
    },
  ],
})

function requireOk(result: ReturnType<typeof parseBoard>): Board {
  if (!result.ok)
    throw new Error(`expected ok, got issues: ${JSON.stringify(result.issues)}`)
  return result.board
}

describe('parseBoard / serializeBoard', () => {
  it('parses an empty string to a fresh empty board', () => {
    const result = parseBoard('')
    const board = requireOk(result)
    expect(board).toEqual(emptyBoard())
    expect(result.ok && result.issues).toEqual([])
  })

  it('parses whitespace-only input the same as empty', () => {
    const board = requireOk(parseBoard('   \n  '))
    expect(board).toEqual(emptyBoard())
  })

  it('parses the JSON Canvas-aligned node/edge schema', () => {
    const result = parseBoard(SAMPLE_RAW)
    const board = requireOk(result)
    expect(result.ok && result.issues).toEqual([])
    expect(board.version).toBe(YOLOBOARD_SCHEMA_VERSION)
    expect(board.camera).toEqual({ x: 10, y: -5, scale: 1.5 })
    expect(board.nodes).toHaveLength(5)
    expect(board.edges).toHaveLength(1)

    expect(board.nodes.find((n) => n.id === 'c1')).toMatchObject({
      type: 'file',
      file: 'Cards/概念A.md',
    })
    expect(board.nodes.find((n) => n.id === 'c2')).toMatchObject({
      type: 'text',
      text: '临时便签',
    })
    expect(board.nodes.find((n) => n.id === 'c3')).toMatchObject({
      type: 'file',
      file: 'papers/foo.pdf',
      color: '4',
    })
    expect(board.nodes.find((n) => n.id === 'g1')).toMatchObject({
      type: 'group',
      label: '一组',
    })
    expect(board.nodes.find((n) => n.id === 'l1')).toMatchObject({
      type: 'link',
      url: 'https://example.com/a',
    })

    expect(board.edges[0]).toMatchObject({
      id: 'e1',
      fromNode: 'c1',
      toNode: 'c2',
      fromSide: 'right',
      toSide: 'left',
      fromEnd: 'arrow',
      toEnd: 'arrow',
      color: '#FF0000',
      label: '',
    })
  })

  it('round-trips serialize -> parse to an equal board', () => {
    const board = requireOk(parseBoard(SAMPLE_RAW))
    const reparsed = requireOk(parseBoard(serializeBoard(board)))
    expect(reparsed).toEqual(board)
  })

  it('serializes with 2-space indent and a trailing newline', () => {
    const board = requireOk(parseBoard(SAMPLE_RAW))
    const text = serializeBoard(board)
    expect(text.endsWith('\n')).toBe(true)
    expect(text).toContain('  "version": 1')
  })

  it('produces a stable, deterministic key order across repeated serializations', () => {
    const board = requireOk(parseBoard(SAMPLE_RAW))
    expect(serializeBoard(board)).toEqual(serializeBoard(board))
  })

  it('applies JSON Canvas edge-end defaults when they are omitted', () => {
    const raw = JSON.stringify({
      version: 1,
      nodes: [
        { id: 'c1', type: 'text', x: 0, y: 0, w: 100, h: 100, text: '' },
        { id: 'c2', type: 'text', x: 200, y: 0, w: 100, h: 100, text: '' },
      ],
      edges: [{ id: 'e1', fromNode: 'c1', toNode: 'c2' }],
    })
    const board = requireOk(parseBoard(raw))
    expect(board.edges[0].fromEnd).toBe('none')
    expect(board.edges[0].toEnd).toBe('arrow')
    expect(board.edges[0].fromSide).toBeUndefined()
    expect(board.edges[0].toSide).toBeUndefined()
  })

  it('accepts a group node with no label', () => {
    const raw = JSON.stringify({
      version: 1,
      nodes: [{ id: 'g1', type: 'group', x: 0, y: 0, w: 100, h: 100 }],
    })
    const board = requireOk(parseBoard(raw))
    expect(board.nodes).toHaveLength(1)
    expect(board.nodes[0]).toMatchObject({ type: 'group' })
  })

  describe('locked', () => {
    it('round-trips a locked board', () => {
      const raw = JSON.stringify({ version: 1, locked: true, nodes: [] })
      const board = requireOk(parseBoard(raw))
      expect(board.locked).toBe(true)
      expect(JSON.parse(serializeBoard(board)).locked).toBe(true)
    })

    it('omits the field entirely for an unlocked board', () => {
      const board = requireOk(parseBoard(JSON.stringify({ version: 1 })))
      expect(board.locked).toBeUndefined()
      expect('locked' in JSON.parse(serializeBoard(board))).toBe(false)
    })

    it('does not treat `locked` as an unknown field', () => {
      const board = requireOk(
        parseBoard(JSON.stringify({ version: 1, locked: true })),
      )
      expect(board.extra).toEqual({})
    })

    it('opens editable when the value is anything but a literal true', () => {
      for (const value of [false, 'true', 1, null, {}]) {
        const board = requireOk(
          parseBoard(JSON.stringify({ version: 1, locked: value })),
        )
        expect(board.locked).toBeUndefined()
      }
    })
  })

  describe('unknown-field forward compatibility', () => {
    it('preserves and round-trips unknown fields at the file, node, and edge level', () => {
      const raw = JSON.stringify({
        version: 1,
        futureTopLevelField: 'kept',
        camera: { x: 0, y: 0, scale: 1 },
        nodes: [
          {
            id: 'c1',
            type: 'file',
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            file: 'a.md',
            // JSON Canvas fields we do not render yet ride along here.
            subpath: '#heading',
            futureNodeField: 42,
          },
          { id: 'c2', type: 'text', x: 0, y: 0, w: 100, h: 100, text: '' },
        ],
        edges: [
          {
            id: 'e1',
            fromNode: 'c1',
            toNode: 'c2',
            futureEdgeField: { nested: true },
          },
        ],
      })
      const board = requireOk(parseBoard(raw))
      expect(board.extra).toEqual({ futureTopLevelField: 'kept' })
      const node = board.nodes.find((n) => n.id === 'c1')
      expect(node?.extra).toEqual({ subpath: '#heading', futureNodeField: 42 })
      expect(board.edges[0].extra).toEqual({
        futureEdgeField: { nested: true },
      })

      const serialized = serializeBoard(board)
      const reparsed = JSON.parse(serialized)
      expect(reparsed.futureTopLevelField).toBe('kept')
      expect(reparsed.nodes[0].subpath).toBe('#heading')
      expect(reparsed.nodes[0].futureNodeField).toBe(42)
      expect(reparsed.edges[0].futureEdgeField).toEqual({ nested: true })
    })
  })

  describe('corrupted / invalid input', () => {
    it('fails with invalid-json for unparsable JSON', () => {
      const result = parseBoard('{not valid json')
      expect(result.ok).toBe(false)
      expect(!result.ok && result.issues[0].type).toBe('invalid-json')
    })

    it('fails with invalid-schema when the root is not a JSON object', () => {
      for (const raw of ['[]', '"a string"', '42', 'null']) {
        const result = parseBoard(raw)
        expect(result.ok).toBe(false)
        expect(!result.ok && result.issues[0].type).toBe('invalid-schema')
      }
    })

    it('fails with invalid-schema for an unsupported version', () => {
      const result = parseBoard(
        JSON.stringify({ version: 2, nodes: [], edges: [] }),
      )
      expect(result.ok).toBe(false)
      expect(!result.ok && result.issues[0].type).toBe('invalid-schema')
    })

    it('fails with invalid-schema when "nodes" is present but not an array', () => {
      const result = parseBoard(JSON.stringify({ version: 1, nodes: {} }))
      expect(result.ok).toBe(false)
    })

    it('opens a pre-D5 board as empty, without destroying its old arrays', () => {
      // No migration exists and none is planned (p3-canvas-parity D6). A
      // board written against the old `cards`/`groups` schema has no `nodes`,
      // so it comes up empty — but its old arrays are unknown top-level
      // fields, which means they round-trip in `extra` and a later save does
      // not erase them.
      const raw = JSON.stringify({
        version: 1,
        cards: [
          { id: 'c1', type: 'text', x: 0, y: 0, w: 100, h: 100, markdown: 'x' },
        ],
        groups: [],
      })
      const board = requireOk(parseBoard(raw))
      // It parses (the root is a valid object) but holds no nodes — the old
      // arrays survive only as opaque `extra`, so nothing is silently lost.
      expect(board.nodes).toHaveLength(0)
      expect(board.extra).toHaveProperty('cards')
      expect(board.extra).toHaveProperty('groups')
    })

    it('drops a duplicate node id and reports it, keeping the file usable', () => {
      const raw = JSON.stringify({
        version: 1,
        nodes: [
          { id: 'c1', type: 'text', x: 0, y: 0, w: 100, h: 100, text: 'first' },
          {
            id: 'c1',
            type: 'text',
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            text: 'second',
          },
        ],
      })
      const result = parseBoard(raw)
      const board = requireOk(result)
      expect(board.nodes).toHaveLength(1)
      expect((board.nodes[0] as { text: string }).text).toBe('first')
      expect(result.ok && result.issues).toContainEqual({
        type: 'duplicate-node-id',
        index: 1,
        id: 'c1',
      })
    })

    it('drops a file node missing "file" and reports it, without failing the whole board', () => {
      const raw = JSON.stringify({
        version: 1,
        nodes: [
          { id: 'c1', type: 'file', x: 0, y: 0, w: 100, h: 100 },
          { id: 'c2', type: 'text', x: 0, y: 0, w: 100, h: 100, text: 'kept' },
        ],
      })
      const result = parseBoard(raw)
      const board = requireOk(result)
      expect(board.nodes).toHaveLength(1)
      expect(board.nodes[0].id).toBe('c2')
      expect(
        result.ok && result.issues.some((i) => i.type === 'invalid-node'),
      ).toBe(true)
    })

    it('drops a link node missing "url" and reports it', () => {
      const raw = JSON.stringify({
        version: 1,
        nodes: [
          { id: 'l1', type: 'link', x: 0, y: 0, w: 100, h: 100 },
          { id: 'c2', type: 'text', x: 0, y: 0, w: 100, h: 100, text: 'kept' },
        ],
      })
      const result = parseBoard(raw)
      const board = requireOk(result)
      expect(board.nodes).toHaveLength(1)
      expect(board.nodes[0].id).toBe('c2')
      expect(
        result.ok && result.issues.some((i) => i.type === 'invalid-node'),
      ).toBe(true)
    })

    it('drops a node with non-finite geometry and reports it', () => {
      // JSON has no NaN/Infinity literal, so a non-numeric "x" (e.g. null)
      // is what a corrupt-geometry node looks like on the wire.
      const raw = JSON.stringify({
        version: 1,
        nodes: [
          { id: 'c1', type: 'text', x: null, y: 0, w: 100, h: 100, text: '' },
        ],
      })
      const result = parseBoard(raw)
      const board = requireOk(result)
      expect(board.nodes).toHaveLength(0)
      expect(
        result.ok && result.issues.some((i) => i.type === 'invalid-node'),
      ).toBe(true)
    })

    it('drops a dangling edge and reports it, without failing the whole board', () => {
      const raw = JSON.stringify({
        version: 1,
        nodes: [
          { id: 'c1', type: 'text', x: 0, y: 0, w: 100, h: 100, text: '' },
        ],
        edges: [{ id: 'e1', fromNode: 'c1', toNode: 'missing' }],
      })
      const result = parseBoard(raw)
      const board = requireOk(result)
      expect(board.edges).toHaveLength(0)
      expect(result.ok && result.issues).toContainEqual({
        type: 'dangling-edge',
        id: 'e1',
        from: 'c1',
        to: 'missing',
      })
    })

    it('ignores a non-string colour rather than failing the node', () => {
      const raw = JSON.stringify({
        version: 1,
        nodes: [
          {
            id: 'c1',
            type: 'text',
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            text: '',
            color: 7,
          },
        ],
      })
      const board = requireOk(parseBoard(raw))
      expect(board.nodes).toHaveLength(1)
      expect(board.nodes[0].color).toBeUndefined()
      expect(board.nodes[0].extra).toEqual({})
    })
  })
})
