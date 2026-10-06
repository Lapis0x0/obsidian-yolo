import { type PlacedTextItem, inferParagraphs, paragraphAt } from './paragraphs'

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
