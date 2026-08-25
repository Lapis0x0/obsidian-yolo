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
  cards: [
    { id: 'c1', type: 'note', x: 0, y: 0, w: 320, h: 240, file: 'Cards/概念A.md' },
    { id: 'c2', type: 'text', x: 400, y: 0, w: 240, h: 120, markdown: '临时便签' },
    { id: 'c3', type: 'pdf', x: 0, y: 400, w: 480, h: 600, file: 'papers/foo.pdf', page: 3 },
  ],
  edges: [
    {
      id: 'e1',
      from: 'c1',
      to: 'c2',
      fromSide: 'right',
      toSide: 'left',
      arrow: 'end',
      label: '',
    },
  ],
  groups: [],
})

function requireOk(result: ReturnType<typeof parseBoard>): Board {
  if (!result.ok) throw new Error(`expected ok, got issues: ${JSON.stringify(result.issues)}`)
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

  it('parses the p1-design §1.1 sample schema', () => {
    const result = parseBoard(SAMPLE_RAW)
    const board = requireOk(result)
    expect(result.ok && result.issues).toEqual([])
    expect(board.version).toBe(YOLOBOARD_SCHEMA_VERSION)
    expect(board.camera).toEqual({ x: 10, y: -5, scale: 1.5 })
    expect(board.cards).toHaveLength(3)
    expect(board.edges).toHaveLength(1)

    const note = board.cards.find((c) => c.id === 'c1')
    expect(note).toMatchObject({ type: 'note', file: 'Cards/概念A.md' })

    const text = board.cards.find((c) => c.id === 'c2')
    expect(text).toMatchObject({ type: 'text', markdown: '临时便签' })

    const pdf = board.cards.find((c) => c.id === 'c3')
    expect(pdf).toMatchObject({ type: 'pdf', file: 'papers/foo.pdf', page: 3 })

    const edge = board.edges[0]
    expect(edge).toMatchObject({
      id: 'e1',
      from: 'c1',
      to: 'c2',
      fromSide: 'right',
      toSide: 'left',
      arrow: 'end',
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

  it('defaults edge "arrow" to "end" when omitted', () => {
    const raw = JSON.stringify({
      version: 1,
      cards: [
        { id: 'c1', type: 'text', x: 0, y: 0, w: 100, h: 100, markdown: '' },
        { id: 'c2', type: 'text', x: 200, y: 0, w: 100, h: 100, markdown: '' },
      ],
      edges: [{ id: 'e1', from: 'c1', to: 'c2' }],
    })
    const board = requireOk(parseBoard(raw))
    expect(board.edges[0].arrow).toBe('end')
    expect(board.edges[0].fromSide).toBeUndefined()
    expect(board.edges[0].toSide).toBeUndefined()
  })

  describe('unknown-field forward compatibility', () => {
    it('preserves and round-trips unknown fields at the file, card, and edge level', () => {
      const raw = JSON.stringify({
        version: 1,
        futureTopLevelField: 'kept',
        camera: { x: 0, y: 0, scale: 1 },
        cards: [
          {
            id: 'c1',
            type: 'note',
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            file: 'a.md',
            futureCardField: 42,
          },
          { id: 'c2', type: 'text', x: 0, y: 0, w: 100, h: 100, markdown: '' },
        ],
        edges: [
          {
            id: 'e1',
            from: 'c1',
            to: 'c2',
            futureEdgeField: { nested: true },
          },
        ],
      })
      const board = requireOk(parseBoard(raw))
      expect(board.extra).toEqual({ futureTopLevelField: 'kept' })
      const card = board.cards.find((c) => c.id === 'c1')
      expect(card?.extra).toEqual({ futureCardField: 42 })
      expect(board.edges[0].extra).toEqual({ futureEdgeField: { nested: true } })

      const serialized = serializeBoard(board)
      const reparsed = JSON.parse(serialized)
      expect(reparsed.futureTopLevelField).toBe('kept')
      expect(reparsed.cards[0].futureCardField).toBe(42)
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
      const result = parseBoard(JSON.stringify({ version: 2, cards: [], edges: [] }))
      expect(result.ok).toBe(false)
      expect(!result.ok && result.issues[0].type).toBe('invalid-schema')
    })

    it('fails with invalid-schema when "cards" is present but not an array', () => {
      const result = parseBoard(JSON.stringify({ version: 1, cards: {} }))
      expect(result.ok).toBe(false)
    })

    it('drops a duplicate card id and reports it, keeping the file usable', () => {
      const raw = JSON.stringify({
        version: 1,
        cards: [
          { id: 'c1', type: 'text', x: 0, y: 0, w: 100, h: 100, markdown: 'first' },
          { id: 'c1', type: 'text', x: 0, y: 0, w: 100, h: 100, markdown: 'second' },
        ],
      })
      const result = parseBoard(raw)
      const board = requireOk(result)
      expect(board.cards).toHaveLength(1)
      expect((board.cards[0] as { markdown: string }).markdown).toBe('first')
      expect(result.ok && result.issues).toContainEqual({
        type: 'duplicate-card-id',
        index: 1,
        id: 'c1',
      })
    })

    it('drops a note card missing "file" and reports it, without failing the whole board', () => {
      const raw = JSON.stringify({
        version: 1,
        cards: [
          { id: 'c1', type: 'note', x: 0, y: 0, w: 100, h: 100 },
          { id: 'c2', type: 'text', x: 0, y: 0, w: 100, h: 100, markdown: 'kept' },
        ],
      })
      const result = parseBoard(raw)
      const board = requireOk(result)
      expect(board.cards).toHaveLength(1)
      expect(board.cards[0].id).toBe('c2')
      expect(result.ok && result.issues.some((i) => i.type === 'invalid-card')).toBe(true)
    })

    it('drops a card with non-finite geometry and reports it', () => {
      // JSON has no NaN/Infinity literal, so a non-numeric "x" (e.g. null)
      // is what a corrupt-geometry card looks like on the wire.
      const raw = JSON.stringify({
        version: 1,
        cards: [{ id: 'c1', type: 'text', x: null, y: 0, w: 100, h: 100, markdown: '' }],
      })
      const result = parseBoard(raw)
      const board = requireOk(result)
      expect(board.cards).toHaveLength(0)
      expect(result.ok && result.issues.some((i) => i.type === 'invalid-card')).toBe(true)
    })

    it('drops a dangling edge and reports it, without failing the whole board', () => {
      const raw = JSON.stringify({
        version: 1,
        cards: [{ id: 'c1', type: 'text', x: 0, y: 0, w: 100, h: 100, markdown: '' }],
        edges: [{ id: 'e1', from: 'c1', to: 'missing' }],
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

    it('rejects a PDF card whose "page" is not a positive integer', () => {
      const raw = JSON.stringify({
        version: 1,
        cards: [{ id: 'c1', type: 'pdf', x: 0, y: 0, w: 100, h: 100, file: 'a.pdf', page: 0 }],
      })
      const board = requireOk(parseBoard(raw))
      expect(board.cards).toHaveLength(0)
    })
  })
})
