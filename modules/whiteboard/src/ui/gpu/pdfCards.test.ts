import type { BoardNode } from '../../domain/fileFormat'
import { READER_METRICS } from '../pdf/readerLayout'

import { pageOfKey, pdfCardImages, pdfPageKey } from './pdfCards'

const base = { id: 'n1', x: 0, y: 0, w: 200, h: 300, extra: {} }
const folded = (startPage?: number): BoardNode => ({
  ...base,
  type: 'file',
  file: 'a.pdf',
  ...(startPage === undefined ? {} : { startPage }),
})
const sheet = (page: number): BoardNode => ({
  ...base,
  type: 'pdf-page',
  parent: 'n0',
  file: 'a.pdf',
  page,
})

/** Pages 100 × 150: 300 tall at the card's 200. */
const pages =
  (count: number) =>
  (page: number): { width: number; height: number } | null =>
    page >= 1 && page <= count ? { width: 100, height: 150 } : null

describe('pdfCardImages', () => {
  test('a sheet is its one page over the whole card', () => {
    expect(pdfCardImages(sheet(3), 200, 300, pages(5))).toEqual([
      { path: pdfPageKey('a.pdf', 3), x: 0, y: 0, w: 200, h: 300, radius: 0 },
    ])
  })

  test('a folded card runs from where it was left, a seam between pages', () => {
    const images = pdfCardImages(folded(2.5), 200, 300, pages(5))
    expect(images.map((image) => [pageOfKey(image.path)?.page, image.y])).toEqual(
      [
        [2, -150],
        [3, 150 + READER_METRICS.gap],
      ],
    )
    expect(images.every((image) => image.w === 200 && image.h === 300)).toBe(
      true,
    )
  })

  test('stops at the first page with no picture', () => {
    const images = pdfCardImages(folded(), 200, 1000, pages(2))
    expect(images.map((image) => pageOfKey(image.path)?.page)).toEqual([1, 2])
  })

  test('no picture of the first page, no images', () => {
    expect(pdfCardImages(folded(), 200, 300, pages(0))).toEqual([])
  })
})

describe('pdfPageKey', () => {
  test('round-trips, and an image path is no page', () => {
    expect(pageOfKey(pdfPageKey('dir/a b.pdf', 12))).toEqual({
      file: 'dir/a b.pdf',
      page: 12,
    })
    expect(pageOfKey('dir/a.png')).toBeNull()
  })
})
