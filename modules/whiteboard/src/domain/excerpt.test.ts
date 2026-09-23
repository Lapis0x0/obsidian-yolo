import {
  areaExcerptCardSize,
  areaExcerptFileName,
  areaExcerptMarkdown,
  excerptQuoteText,
  parsePdfLink,
  parsePdfSubpath,
  pdfSubpath,
  textExcerptCardSize,
  textExcerptMarkdown,
} from './excerpt'

const METRICS = { width: 390, grid: 13, minHeight: 104, maxHeight: 520 }

describe('parsePdfSubpath', () => {
  it('reads a page and a selection', () => {
    expect(parsePdfSubpath('page=3&selection=12,0,15,31')).toEqual({
      page: 3,
      selection: [12, 0, 15, 31],
    })
  })

  it('reads a page alone', () => {
    expect(parsePdfSubpath('page=7')).toEqual({ page: 7, selection: null })
  })

  it('ignores the colour Obsidian adds to a highlight link', () => {
    expect(parsePdfSubpath('page=2&selection=1,2,3,4&color=yellow')).toEqual({
      page: 2,
      selection: [1, 2, 3, 4],
    })
  })

  it('keeps the page when the selection is malformed', () => {
    expect(parsePdfSubpath('page=2&selection=1,2,x,4')).toEqual({
      page: 2,
      selection: null,
    })
    expect(parsePdfSubpath('page=2&selection=1,2,3')).toEqual({
      page: 2,
      selection: null,
    })
  })

  it('names nothing without a valid page', () => {
    expect(parsePdfSubpath('Heading')).toBeNull()
    expect(parsePdfSubpath('page=0')).toBeNull()
    expect(parsePdfSubpath('page=2.5')).toBeNull()
    expect(parsePdfSubpath('selection=1,2,3,4')).toBeNull()
  })

  it('round-trips what pdfSubpath writes', () => {
    expect(parsePdfSubpath(pdfSubpath(4, [1, 0, 2, 5]).slice(1))).toEqual({
      page: 4,
      selection: [1, 0, 2, 5],
    })
    expect(pdfSubpath(4)).toBe('#page=4')
  })
})

describe('parsePdfLink', () => {
  it('splits the file from the location', () => {
    expect(parsePdfLink('papers/a b.pdf#page=3&selection=1,0,1,4')).toEqual({
      linkpath: 'papers/a b.pdf',
      target: { page: 3, selection: [1, 0, 1, 4] },
    })
  })

  it('decodes a Markdown link’s escaped path', () => {
    expect(parsePdfLink('a%20b.pdf#page=1')?.linkpath).toBe('a b.pdf')
  })

  it('is null for a link without a PDF location', () => {
    expect(parsePdfLink('note')).toBeNull()
    expect(parsePdfLink('note#Heading')).toBeNull()
  })
})

describe('excerptQuoteText', () => {
  it('joins layout line breaks with spaces', () => {
    expect(excerptQuoteText('The quick brown\nfox jumps\n  over')).toBe(
      'The quick brown fox jumps over',
    )
  })

  it('joins CJK lines without a space', () => {
    expect(excerptQuoteText('这是一段\n中文文本\nand English')).toBe(
      '这是一段中文文本 and English',
    )
  })

  it('keeps a line-end hyphen and joins after it', () => {
    expect(excerptQuoteText('state-of-the-\nart models')).toBe(
      'state-of-the-art models',
    )
  })
})

describe('excerpt Markdown', () => {
  it('writes a text excerpt as a quote with its link under it', () => {
    expect(
      textExcerptMarkdown(
        'two\nlines',
        '[[a.pdf#page=1&selection=0,0,1,5|a, p.1]]',
      ),
    ).toBe('> two lines\n\n[[a.pdf#page=1&selection=0,0,1,5|a, p.1]]')
  })

  it('embeds an area excerpt’s picture above its page link', () => {
    expect(areaExcerptMarkdown('[[x.png]]', '[[a.pdf#page=2|a, p.2]]')).toBe(
      '![[x.png]]\n\n[[a.pdf#page=2|a, p.2]]',
    )
    expect(
      areaExcerptMarkdown('[x.png](att/x.png)', '[a, p.2](a.pdf#page=2)'),
    ).toBe('![x.png](att/x.png)\n\n[a, p.2](a.pdf#page=2)')
  })

  it('names an area’s PNG after its PDF, page and time, safely', () => {
    expect(
      areaExcerptFileName('Paper [v2]', 3, new Date(2026, 8, 23, 9, 5, 7)),
    ).toBe('Paper v2 p3 20260923090507.png')
  })
})

describe('excerpt card sizes', () => {
  it('grows a text card with its quote, on the grid, within bounds', () => {
    const short = textExcerptCardSize('A short line.', METRICS)
    const long = textExcerptCardSize('word '.repeat(400), METRICS)
    expect(short).toEqual({ w: 390, h: 104 })
    expect(long.h).toBe(520)
    const mid = textExcerptCardSize('word '.repeat(40), METRICS)
    expect(mid.h).toBeGreaterThan(short.h)
    expect(mid.h).toBeLessThan(long.h)
    expect(mid.h % 13).toBe(0)
  })

  it('counts CJK as wide', () => {
    const latin = textExcerptCardSize('a'.repeat(150), METRICS)
    const cjk = textExcerptCardSize('字'.repeat(150), METRICS)
    expect(cjk.h).toBeGreaterThan(latin.h)
  })

  it('fits an area card to its picture at the card width', () => {
    // 740px wide shows at 370: a 2:1 picture is 185 tall, plus the link.
    const wide = areaExcerptCardSize({ width: 740, height: 370 }, METRICS)
    expect(wide.h).toBe(247)
    // A small picture shows at its own size.
    const small = areaExcerptCardSize({ width: 100, height: 300 }, METRICS)
    expect(small.h).toBe(364)
  })
})
