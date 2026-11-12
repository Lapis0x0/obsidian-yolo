// Pictures of HTML cards' pages (./pictures.ts's source 'page'): what a
// page's window showed when it was last put away, for the overview to show
// in place of a page that is not up.
//
// A page is shown by itself wherever it can be: its card keeps its frame at
// every zoom, so a page that moves goes on moving zoomed out (canvas.ts's
// `isDrawn`). A picture stands in only for a page that is not there — one
// past the number kept up at once, or not loaded yet.
//
// Handed in rather than made: a page is drawn by the browser, in a sandbox
// the board cannot see into, so the only picture there is of it is the one
// the page draws of itself (../canvas/pageBridge.ts), and it can be asked
// only while it is up. So one is taken at the one moment that needs no
// deciding — as the page is put away (cardRenderer.ts's `parkCard`), which is
// the last anyone saw of it, whether it was still or moving — and given to
// the scheduler (`Pictures.put`), which never asks this source to draw. Kept
// on the device, since a page that is not loaded cannot be asked again.
//
// A group is a board, a picture a card on it, as for card pictures. Its
// stamp names what the board knows of the page without it: the file's
// version, the size the card shows it at, and the theme it follows.

import type { PictureStore } from '../../host/pictureStore'

import type { PictureRef, PictureSource, PictureTurn } from './pictures'

/** The picture of the page on card `id` of the board at `boardPath`. */
export function pageRef(boardPath: string, id: string): PictureRef {
  return { source: 'page', group: boardPath, key: id }
}

/** A page picture's stamp: the file's version, the size the card shows it
 * at, and the theme it follows. */
export function pageStamp(
  mtime: number,
  size: Readonly<{ w: number; h: number }>,
  dark: boolean,
): string {
  return `${mtime}.${Math.round(size.w)}x${Math.round(size.h)}.${dark ? 'dark' : 'light'}`
}

export class PagePictures implements PictureSource {
  readonly id = 'page' as const
  readonly label = 'page picture'
  readonly turn: PictureTurn = {
    begin: () => false,
    end: () => undefined,
    withdraw: () => undefined,
  }

  constructor(readonly store: PictureStore) {}

  /** A board's pages are one group for as long as it is the board: each
   * picture says by its stamp whether it is still its page's. */
  version(boardPath: string): number | null {
    return boardPath === '' ? null : 0
  }

  /** Never: a page's picture is handed in (`Pictures.put`). */
  canDraw(): boolean {
    return false
  }

  draw(): Promise<'unavailable'> {
    return Promise.resolve('unavailable')
  }
}
