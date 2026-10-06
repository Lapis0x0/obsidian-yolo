import {
  type PlacedTextItem,
  inferParagraphs,
  orderedTuple,
  paragraphAt,
  positionNear,
  tupleBoxes,
  tupleText,
} from './paragraphs'

/** A line of body text `row` lines down (line height 0.02, leading 0.006). */
function line(
  row: number,
  text: string,
  options: {
    left?: number
    right?: number
    top?: number
    height?: number
  } = {},
): PlacedTextItem {
  const height = options.height ?? 0.02
  const top = options.top ?? 0.1 + row * 0.026
  return {
    text,
    endsLine: true,
    box: {
      left: options.left ?? 0.1,
      right: options.right ?? 0.9,
      top,
      bottom: top + height,
    },
  }
}

describe('inferParagraphs', () => {
  it('keeps closely set lines together and breaks at a gap', () => {
    const items = [
      line(0, 'one'),
      line(1, 'two'),
      line(2, 'three', { right: 0.5 }),
      line(0, 'four', { top: 0.2 }),
      line(0, 'five', { top: 0.226 }),
    ]
    const paragraphs = inferParagraphs(items)
    expect(paragraphs.map((p) => [p.first, p.last])).toEqual([
      [0, 2],
      [3, 4],
    ])
    expect(paragraphs[0].lines).toHaveLength(3)
  })

  it('breaks at a heading and at a first-line indent', () => {
    const items = [
      line(0, 'Heading', { height: 0.04 }),
      line(2, 'body'),
      line(3, 'body'),
      line(4, 'indented', { left: 0.14 }),
      line(5, 'body'),
    ]
    expect(inferParagraphs(items).map((p) => [p.first, p.last])).toEqual([
      [0, 0],
      [1, 2],
      [3, 4],
    ])
  })

  it('joins the items of one line and breaks between columns', () => {
    const items: PlacedTextItem[] = [
      {
        text: 'left ',
        endsLine: false,
        box: { left: 0.1, right: 0.2, top: 0.1, bottom: 0.12 },
      },
      {
        text: 'half',
        endsLine: true,
        box: { left: 0.2, right: 0.45, top: 0.1, bottom: 0.12 },
      },
      {
        text: 'right',
        endsLine: true,
        box: { left: 0.55, right: 0.9, top: 0.1, bottom: 0.12 },
      },
    ]
    expect(inferParagraphs(items).map((p) => [p.first, p.last])).toEqual([
      [0, 1],
      [2, 2],
    ])
  })

  it('carries empty items with their line', () => {
    const items: PlacedTextItem[] = [
      line(0, 'one'),
      { text: '', endsLine: false, box: null },
      line(1, 'two'),
    ]
    expect(inferParagraphs(items).map((p) => [p.first, p.last])).toEqual([
      [0, 2],
    ])
  })
})

describe('paragraphAt', () => {
  const paragraphs = inferParagraphs([
    line(0, 'a'),
    line(1, 'b'),
    line(0, 'c', { top: 0.3 }),
  ])

  it('finds the paragraph under a point, or near it', () => {
    expect(paragraphAt(paragraphs, 0.5, 0.11)?.first).toBe(0)
    expect(paragraphAt(paragraphs, 0.5, 0.155)?.first).toBe(0)
    expect(paragraphAt(paragraphs, 0.5, 0.31)?.first).toBe(2)
  })

  it('finds none in the space between them', () => {
    expect(paragraphAt(paragraphs, 0.5, 0.23)).toBeNull()
  })
})

describe('positionNear / tupleText / tupleBoxes', () => {
  const items: PlacedTextItem[] = [
    {
      text: 'hello world',
      endsLine: true,
      box: { left: 0.1, right: 0.65, top: 0.1, bottom: 0.12 },
    },
    {
      text: '中文段落',
      endsLine: true,
      box: { left: 0.1, right: 0.5, top: 0.13, bottom: 0.15 },
    },
  ]

  it('snaps a point inside a word to its nearer edge', () => {
    // 'hello world' over 0.55: 0.05 a character; both are inside "hello".
    expect(positionNear(items, 0.15, 0.11)).toEqual({ item: 0, offset: 0 })
    expect(positionNear(items, 0.32, 0.11)).toEqual({ item: 0, offset: 5 })
  })

  it('takes each CJK character as a word', () => {
    expect(positionNear(items, 0.3, 0.14)).toEqual({ item: 1, offset: 2 })
  })

  it('reads and boxes a tuple across lines', () => {
    expect(tupleText(items, [0, 6, 1, 2])).toBe('world\n中文')
    const boxes = tupleBoxes(items, [0, 6, 1, 2])
    expect(boxes).toHaveLength(2)
    expect(boxes[0].left).toBeCloseTo(0.4)
    expect(boxes[1].right).toBeCloseTo(0.3)
  })

  it('orders a tuple whatever end was dragged past the other', () => {
    expect(
      orderedTuple({ item: 1, offset: 2 }, { item: 0, offset: 3 }),
    ).toEqual([0, 3, 1, 2])
  })
})
