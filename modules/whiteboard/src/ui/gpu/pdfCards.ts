// PDF cards as the GPU scene draws them far away: their pages' pictures
// (../pictures/pdfPages.ts) as images in the card, where the overview drew
// them (../canvas/overviewLayer.ts's `drawPicture`) — a sheet of a spread its
// page over the whole sheet, a folded card the pages its reader shows from
// where it was left, edge to edge at the card's width with a seam between
// each (../pdf/readerLayout.ts), as far down as there are pictures.
//
// A page's image names its picture by a key of its own (`pdfPageKey`), which
// the board turns back into the page's picture — its annotations painted
// in — when the scene asks for it.

import type { BoardNode } from '../../domain/fileFormat'
import { fileNodeKind } from '../../domain/naming'
import { isSpreadTitle } from '../../domain/spread'
import { READER_METRICS } from '../pdf/readerLayout'

import type { CardImage } from './scene'

/** What a page's picture is known by: its size. */
export type PageSize = Readonly<{ width: number; height: number }>

/** A PDF card the scene draws: a sheet of a spread, or a folded card. */
export function isScenePdf(node: BoardNode): boolean {
  if (node.type === 'pdf-page') return true
  return (
    node.type === 'file' &&
    fileNodeKind(node.file) === 'pdf' &&
    !isSpreadTitle(node)
  )
}

/** The page a PDF card shows first. */
export function firstPage(node: BoardNode): Readonly<{
  file: string
  page: number
}> | null {
  if (node.type === 'pdf-page') return { file: node.file, page: node.page }
  if (node.type !== 'file') return null
  return { file: node.file, page: Math.floor(node.startPage ?? 1) }
}

const KEY_HEAD = '\u0000pdf\u0000'

/** The image key of a PDF's page: no file's path, which never holds a
 * NUL. */
export function pdfPageKey(file: string, page: number): string {
  return `${KEY_HEAD}${page}\u0000${file}`
}

/** The page an image key names, or null for an image file's path. */
export function pageOfKey(
  key: string,
): Readonly<{ file: string; page: number }> | null {
  if (!key.startsWith(KEY_HEAD)) return null
  const rest = key.slice(KEY_HEAD.length)
  const split = rest.indexOf('\u0000')
  return { page: Number(rest.slice(0, split)), file: rest.slice(split + 1) }
}

/**
 * A PDF card's pages as images in it, in its own units — `w` by `h`: a
 * sheet's one page over all of it; a folded card's from `startPage`, its
 * part above the card cut off, each as tall as its picture is in shape,
 * down past the card's bottom or to the first page with no picture.
 */
export function pdfCardImages(
  node: BoardNode,
  w: number,
  h: number,
  picture: (page: number) => PageSize | null,
): CardImage[] {
  const start = firstPage(node)
  if (!start || !picture(start.page)) return []
  if (node.type === 'pdf-page') {
    return [
      { path: pdfPageKey(start.file, start.page), x: 0, y: 0, w, h, radius: 0 },
    ]
  }
  const images: CardImage[] = []
  let page = start.page
  let size = picture(page)
  const from = node.type === 'file' ? (node.startPage ?? 1) : 1
  let y = size ? -(from - page) * heightOf(size, w) : 0
  while (size && y < h) {
    const height = heightOf(size, w)
    images.push({
      path: pdfPageKey(start.file, page),
      x: 0,
      y,
      w,
      h: height,
      radius: 0,
    })
    y += height + READER_METRICS.gap
    page += 1
    size = y < h ? picture(page) : null
  }
  return images
}

function heightOf(size: PageSize, width: number): number {
  return (width * size.height) / size.width
}
