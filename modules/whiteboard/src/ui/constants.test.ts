import {
  GRID_WORLD_STEP_PX,
  NEW_EMBED_CARD_SIZE,
  NEW_PDF_CARD_SIZE,
  pdfCardSize,
} from './constants'

describe('pdfCardSize', () => {
  // The height the first page takes at the card's width.
  const pageHeight = (page: { width: number; height: number }) =>
    (NEW_EMBED_CARD_SIZE.w * page.height) / page.width

  it.each([
    ['A4', { width: 595, height: 842 }],
    ['Letter', { width: 612, height: 792 }],
    ['landscape A4', { width: 842, height: 595 }],
  ])('shows the whole first page of %s and nothing past it', (_, page) => {
    const size = pdfCardSize(page)
    expect(size.w).toBe(NEW_EMBED_CARD_SIZE.w)
    expect(size.h % GRID_WORLD_STEP_PX).toBe(0)
    expect(size.h).toBeLessThanOrEqual(pageHeight(page))
    expect(size.h).toBeGreaterThan(pageHeight(page) - GRID_WORLD_STEP_PX)
  })

  it('falls back to A4 for a page with no size', () => {
    expect(pdfCardSize({ width: 0, height: 0 })).toEqual(NEW_PDF_CARD_SIZE)
  })
})
