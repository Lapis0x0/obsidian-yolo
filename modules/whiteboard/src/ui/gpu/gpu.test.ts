import { shelfSpot } from './atlas'
import { absoluteSrc, splitFamilies } from './fontSources'
import { fontSize, placeRun, resizeFont } from './glyphs'
import { GLYPH_WORDS, RECT_WORDS, cardInstances, packColor } from './instances'
import { glyphKey, iconKey, parseKey } from './typesetProtocol'

const advance = (glyph: string): number =>
  (glyph.codePointAt(0) ?? 0) > 0x2e80 ? 16 : 8

describe('placeRun', () => {
  test('spreads the glyphs to the run’s measured width', () => {
    // Natural 24, measured 26: the 2 is shared between the two gaps.
    const placed = placeRun('abc', 26, advance)
    expect(placed.map((p) => [p.text, p.x])).toEqual([
      ['a', 0],
      ['b', 9],
      ['c', 18],
    ])
  })

  test('takes blanks’ room without drawing them, and keeps clusters whole', () => {
    const placed = placeRun('a 👍🏽b', 8 + 8 + 8 + 8, advance)
    expect(placed.map((p) => p.text)).toEqual(['a', '👍🏽', 'b'])
  })
})

test('fontSize and resizeFont read and change a font string’s size', () => {
  expect(fontSize('italic 650 15.5px "Inter", sans-serif')).toBe(15.5)
  expect(resizeFont('650 15px Inter', 31)).toBe('650 31px Inter')
})

describe('shelfSpot', () => {
  test('fills a shelf, then opens the next one below it', () => {
    const shelves: { y: number; height: number; x: number }[] = []
    expect(shelfSpot(shelves, 60, 20, 100)).toEqual({ x: 0, y: 0 })
    expect(shelfSpot(shelves, 30, 18, 100)).toEqual({ x: 60, y: 0 })
    // No room left on the first shelf.
    expect(shelfSpot(shelves, 30, 20, 100)).toEqual({ x: 0, y: 20 })
    // Too short for a 20-high shelf: a shelf of its own.
    expect(shelfSpot(shelves, 10, 5, 100)).toEqual({ x: 0, y: 40 })
  })

  test('says when the page is full', () => {
    const shelves: { y: number; height: number; x: number }[] = []
    expect(shelfSpot(shelves, 100, 60, 100)).not.toBeNull()
    expect(shelfSpot(shelves, 10, 50, 100)).toBeNull()
  })
})

describe('cardInstances', () => {
  const ids = new Map<string, number>()
  const deps = {
    glyphId: (text: string, font: string) => {
      const key = `${font}|${text}`
      if (!ids.has(key)) ids.set(key, ids.size)
      return ids.get(key) ?? -1
    },
    iconId: () => 99,
    color: () => packColor(1, 2, 3, 255),
    measure: (text: string) =>
      Array.from(text).reduce((sum, ch) => sum + advance(ch), 0),
    advance,
  }

  test('a run is a glyph each, a rectangle stays one', () => {
    const out = cardInstances(
      [
        { op: 'rect', x: 1, y: 2, w: 3, h: 4, radius: 5, color: 'x' },
        { op: 'text', x: 10, y: 20, text: 'aba', font: 'f', color: 'x' },
      ],
      deps,
    )
    expect(out.rects.length).toBe(RECT_WORDS)
    expect(Array.from(new Float32Array(out.rects.buffer).slice(1, 6))).toEqual([
      1, 2, 3, 4, 5,
    ])
    expect(out.rects[7]).toBe(packColor(1, 2, 3, 255))
    expect(out.glyphs.length).toBe(GLYPH_WORDS * 3)
    const floats = new Float32Array(out.glyphs.buffer)
    expect([0, 1, 2].map((i) => floats[i * GLYPH_WORDS + 1])).toEqual([
      10, 18, 26,
    ])
    // Two glyphs, one of them twice.
    expect(out.glyphIds.length).toBe(2)
  })

  test('a rule is a rectangle along it, a dot a round one', () => {
    const out = cardInstances(
      [
        { op: 'line', x1: 0, y1: 10, x2: 50, y2: 10, color: 'x', width: 2 },
        { op: 'dot', x: 5, y: 5, r: 2, color: 'x' },
      ],
      deps,
    )
    const floats = new Float32Array(out.rects.buffer)
    expect(Array.from(floats.slice(1, 6))).toEqual([0, 9, 50, 2, 0])
    expect(Array.from(floats.slice(RECT_WORDS + 1, RECT_WORDS + 6))).toEqual([
      3, 3, 4, 4, 2,
    ])
  })
})

describe('font sources', () => {
  test('a family list unquoted, a src made absolute but data left be', () => {
    expect(splitFamilies(`"Inter Variable", 'A B', serif`)).toEqual([
      'Inter Variable',
      'A B',
      'serif',
    ])
    expect(
      absoluteSrc(
        `url("./public/Inter.woff2") format("woff2"), url(data:font/woff2;base64,AA==), local(Inter)`,
        'app://obsidian.md/app.css',
      ),
    ).toBe(
      `url("app://obsidian.md/public/Inter.woff2") format("woff2"), url("data:font/woff2;base64,AA=="), local(Inter)`,
    )
  })
})

test('a glyph or icon key reads back as what it names', () => {
  expect(parseKey(glyphKey('国', '400 15px Inter'))).toEqual({
    kind: 'glyph',
    font: '400 15px Inter',
    text: '国',
  })
  expect(parseKey(iconKey('check', 15))).toEqual({
    kind: 'icon',
    name: 'check',
    size: 15,
  })
})
