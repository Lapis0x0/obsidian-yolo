import {
  type PageSize,
  layoutPages,
  needsSharperBitmap,
  pagesInBand,
  parsePageInput,
  positionAt,
  scrollTopFor,
} from './readerLayout'

const LETTER: PageSize = { width: 612, height: 792 }
const metrics = { padding: 10, gap: 20 }

function uniform(count: number, size: PageSize = LETTER): PageSize[] {
  return Array.from({ length: count }, () => size)
}

describe('layoutPages', () => {
  it('fits every page to the reader width and stacks them with gaps', () => {
    const layout = layoutPages(uniform(3), 632, metrics)
    expect(layout.pageWidth).toBe(612)
    expect(layout.scales).toEqual([1, 1, 1])
    expect(layout.tops).toEqual([10, 822, 1634])
    expect(layout.heights).toEqual([792, 792, 792])
    expect(layout.totalHeight).toBe(1634 + 792 + 10)
  })

  it('fits a landscape page to the same width as its portrait neighbours', () => {
    const layout = layoutPages(
      [LETTER, { width: 792, height: 612 }],
      632,
      metrics,
    )
    expect(layout.scales[1]).toBeCloseTo(612 / 792)
    expect(layout.heights[1]).toBeCloseTo(612 * (612 / 792))
  })

  it('never lays a page out narrower than a pixel', () => {
    expect(layoutPages(uniform(1), 0, metrics).pageWidth).toBe(1)
  })
})

describe('pagesInBand', () => {
  const layout = layoutPages(uniform(10), 632, metrics)

  it('names the pages the viewport shows', () => {
    // 812 px per page+gap; a 400 px viewport at 900 sits inside page 2.
    expect(pagesInBand(layout, 900, 400, 0)).toEqual({ first: 1, last: 1 })
    expect(pagesInBand(layout, 700, 400, 0)).toEqual({ first: 0, last: 1 })
  })

  it('widens by the overscan on both sides, clamped to the document', () => {
    expect(pagesInBand(layout, 900, 400, 400)).toEqual({ first: 0, last: 2 })
    expect(pagesInBand(layout, 0, 400, 5000)).toEqual({ first: 0, last: 6 })
    expect(pagesInBand(layout, 7800, 400, 5000)).toEqual({ first: 3, last: 9 })
  })

  it('answers null for an empty document', () => {
    expect(pagesInBand(layoutPages([], 632, metrics), 0, 400, 0)).toBeNull()
  })
})

describe('reading position', () => {
  const layout = layoutPages(uniform(5), 632, metrics)

  it('reads the page under the top edge and how far down it is', () => {
    expect(positionAt(layout, 0)).toBe(1)
    expect(positionAt(layout, 10)).toBe(1)
    expect(positionAt(layout, 822 + 198)).toBeCloseTo(2.25)
  })

  it('reads the gap below a page as its bottom, not as the next page', () => {
    const position = positionAt(layout, 10 + 792 + 5)
    expect(Math.floor(position)).toBe(1)
    expect(position).toBeLessThan(2)
  })

  it('round-trips through the scroll offset', () => {
    for (const position of [1, 1.5, 2.25, 4.9, 5]) {
      expect(positionAt(layout, scrollTopFor(layout, position))).toBeCloseTo(
        position,
      )
    }
  })

  it('survives a relayout at another width: same page, same fraction', () => {
    const wide = layoutPages(uniform(5), 1264, metrics)
    const offset = scrollTopFor(layout, 3.4)
    const position = positionAt(layout, offset)
    expect(positionAt(wide, scrollTopFor(wide, position))).toBeCloseTo(3.4)
  })

  it('clamps a position outside the document to its ends', () => {
    expect(scrollTopFor(layout, 0)).toBe(10)
    expect(scrollTopFor(layout, 99)).toBeCloseTo(
      layout.tops[4] + 0.9999 * layout.heights[4],
    )
    expect(scrollTopFor(layout, Number.NaN)).toBe(0)
  })
})

describe('parsePageInput', () => {
  it('reads a page number and clamps it into the document', () => {
    expect(parsePageInput(' 3 ', 12)).toBe(3)
    expect(parsePageInput('0', 12)).toBe(1)
    expect(parsePageInput('40', 12)).toBe(12)
  })

  it('refuses anything that is not a whole page number', () => {
    for (const value of ['', 'abc', '2.5', '-1', '1e3']) {
      expect(parsePageInput(value, 12)).toBeNull()
    }
  })
})

describe('needsSharperBitmap', () => {
  it('redraws what was never drawn', () => {
    expect(needsSharperBitmap(0, 2)).toBe(true)
  })

  it('redraws once zooming in has outrun the bitmap', () => {
    expect(needsSharperBitmap(2, 2.1)).toBe(false)
    expect(needsSharperBitmap(2, 2.4)).toBe(true)
  })

  it('keeps a sharper bitmap until it holds far more pixels than it shows', () => {
    expect(needsSharperBitmap(4, 2.5)).toBe(false)
    expect(needsSharperBitmap(4, 1.5)).toBe(true)
  })
})
