import type { HighlightAnchor } from '../../domain/pdfAnnotations'

import {
  type PageFrame,
  foldForAnchor,
  hitTestAnnotations,
  quadBoxes,
  quoteContext,
  rectBox,
  resolveHighlightSelection,
} from './annotationGeometry'
import type { SearchTextItem } from './textSearch'

/** A 600 × 800 page with no rotation: y flips, origin at the bottom. */
const upright: PageFrame = {
  width: 600,
  height: 800,
  toViewport: ([x, y]) => [x, 800 - y],
}

/** The same page turned 90° clockwise: shown 800 wide, 600 tall. */
const turned: PageFrame = {
  width: 800,
  height: 600,
  toViewport: ([x, y]) => [y, x],
}

const item = (text: string, endsLine = false): SearchTextItem => ({
  text,
  endsLine,
})

describe('quad and rect boxes', () => {
  it('maps each quad to its box as page fractions', () => {
    const boxes = quadBoxes(
      [
        ...[60, 700, 300, 700, 60, 680, 300, 680],
        ...[60, 680, 120, 680, 60, 660, 120, 660],
      ],
      upright,
    )
    expect(boxes).toHaveLength(2)
    expect(boxes[0]).toEqual({
      left: 0.1,
      top: 100 / 800,
      right: 0.5,
      bottom: 120 / 800,
    })
    expect(boxes[1].right).toBeCloseTo(0.2)
  })

  it('follows the page rotation', () => {
    const [box] = quadBoxes([60, 700, 300, 700, 60, 680, 300, 680], turned)
    expect(box).toEqual({
      left: 680 / 800,
      top: 60 / 600,
      right: 700 / 800,
      bottom: 300 / 600,
    })
  })

  it('orders a rect’s corners whichever way round they come', () => {
    expect(rectBox([300, 200, 60, 600], upright)).toEqual({
      left: 0.1,
      top: 0.25,
      right: 0.5,
      bottom: 0.75,
    })
  })
})

describe('hitTestAnnotations', () => {
  const entries = [
    { id: 'area', boxes: [{ left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 }] },
    {
      id: 'line',
      boxes: [{ left: 0.2, top: 0.4, right: 0.6, bottom: 0.42 }],
    },
  ]

  it('picks the smallest annotation under the point', () => {
    expect(hitTestAnnotations(entries, [0.3, 0.41])).toBe('line')
    expect(hitTestAnnotations(entries, [0.3, 0.6])).toBe('area')
  })

  it('misses outside every box, and slop widens thin ones', () => {
    expect(hitTestAnnotations(entries, [0.95, 0.5])).toBeNull()
    expect(hitTestAnnotations(entries.slice(1), [0.3, 0.425])).toBeNull()
    expect(hitTestAnnotations(entries.slice(1), [0.3, 0.425], 0.01)).toBe(
      'line',
    )
  })
})

describe('quoteContext', () => {
  it('takes the text either side, across items and lines', () => {
    const items = [
      item('The quick ', false),
      item('brown fox', true),
      item('jumps'),
    ]
    // "brown" is item 1, offsets 0–5.
    expect(quoteContext(items, [1, 0, 1, 5], 6)).toEqual({
      prefix: 'quick ',
      suffix: ' fox\nj',
    })
  })
})

describe('resolveHighlightSelection', () => {
  const anchor = (
    exact: string,
    selection?: HighlightAnchor['selection'],
    context: { prefix?: string; suffix?: string } = {},
  ): HighlightAnchor => ({
    page: 1,
    quadPoints: [0, 0, 1, 0, 0, 1, 1, 1],
    quote: { exact, ...context },
    ...(selection ? { selection } : {}),
  })

  it('keeps the stored tuple when it still names the quote', () => {
    const items = [item('alpha beta gamma')]
    expect(
      resolveHighlightSelection(items, anchor('beta', [0, 6, 0, 10])),
    ).toEqual([0, 6, 0, 10])
  })

  it('finds the quote again when the text layer is split differently', () => {
    // Made against one item; the page now splits it in three.
    const items = [item('alpha '), item('be'), item('ta gamma')]
    expect(
      resolveHighlightSelection(items, anchor('beta', [0, 6, 0, 10])),
    ).toEqual([1, 0, 2, 2])
  })

  it('uses the context to choose between repeated quotes', () => {
    const items = [item('one cat here, two cat there')]
    expect(
      resolveHighlightSelection(
        items,
        anchor('cat', undefined, { prefix: 'two ', suffix: ' there' }),
      ),
    ).toEqual([0, 18, 0, 21])
    expect(resolveHighlightSelection(items, anchor('cat'))).toEqual([
      0, 4, 0, 7,
    ])
  })

  it('matches a quote spanning a line break, Latin and CJK alike', () => {
    const latin = [item('first', true), item('second')]
    expect(
      resolveHighlightSelection(latin, anchor('first\nsecond', [9, 0, 9, 1])),
    ).toEqual([0, 0, 1, 6])
    const cjk = [item('视觉', true), item('原语')]
    expect(resolveHighlightSelection(cjk, anchor('视觉\n原语'))).toEqual([
      0, 0, 1, 2,
    ])
  })

  it('is null when the quote is gone', () => {
    expect(resolveHighlightSelection([item('nothing')], anchor('cat'))).toBe(
      null,
    )
  })
})

describe('foldForAnchor', () => {
  it('joins CJK lines with nothing and Latin lines with a space', () => {
    expect(foldForAnchor('视觉\n 原语')).toBe('视觉原语')
    expect(foldForAnchor('Visual\nPrimitives')).toBe('visual primitives')
  })
})
