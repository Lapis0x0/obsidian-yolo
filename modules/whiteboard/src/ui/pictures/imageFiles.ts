// Pictures of image files (./pictures.ts's source 'image'): a group is a
// version of the file, with one picture in it, whatever card or board shows
// it — the card fits it in itself, as it fits the image.
//
// What an image card shows is the file itself (`vault.getResourceUrl`), which
// arrives only once the file is read and decoded at its own size — a photo of
// a few megabytes is a blank card for a moment, and the overview had nothing
// to draw for it but its name. The picture is the file decoded small, once:
// `createImageBitmap` decodes it off the main thread and scales it on the way,
// so what the main thread does is copy a small bitmap onto a canvas for the
// store to encode.
//
// An SVG cannot be decoded that way: it is drawn instead, through an image
// element, which is main-thread work and waits for an idle slice
// (./idle.ts). A GIF gives its first frame.

import type { PictureStore } from '../../host/pictureStore'

import type { IdleSlices } from './idle'
import type {
  DrawnPicture,
  PictureRef,
  PictureSource,
  PictureTurn,
  WantedPicture,
} from './pictures'

/** How wide an image's picture is made, in pixels: a card as wide as a new
 * embed (~400 world units) at the overview's sharpest zoom on a 2× display,
 * with room to spare. A smaller image is scaled up to it — a few kilobytes
 * kept, and a picture that is always the same width to hold at a level. */
export const IMAGE_PICTURE_WIDTH = 480
/** Past this tall, a picture is scaled down to fit: a long strip of an
 * image would otherwise be held many screens tall. */
const IMAGE_PICTURE_MAX_HEIGHT = 1600

/** The picture of the image file at `path`. */
export function imageRef(path: string): PictureRef {
  return { source: 'image', group: path, key: '' }
}

export type ImageFilesDeps = Readonly<{
  vault: YoloModuleHostApiV1['vault']
  store: PictureStore
  doc: Document
  slices: IdleSlices
  /** When the file at `path` was last modified; null when it is not a
   * file now. */
  mtime: (path: string) => number | null
  /** Whether a picture may be started now (./idle.ts's `ready`). */
  ready: () => boolean
}>

export class ImageFiles implements PictureSource {
  readonly id = 'image' as const
  readonly label = 'image thumbnail'
  readonly store: PictureStore
  readonly turn: PictureTurn

  constructor(private readonly deps: ImageFilesDeps) {
    this.store = deps.store
    // The scheduler asks once a frame; nothing has to be woken.
    this.turn = {
      begin: () => deps.ready(),
      end: () => undefined,
      withdraw: () => undefined,
    }
  }

  version(path: string): number | null {
    return this.deps.mtime(path)
  }

  /** What is drawn is kept in an idle slice of its own. */
  settle(): Promise<boolean> {
    return this.deps.slices.next()
  }

  async draw(
    want: WantedPicture,
    _version: number,
  ): Promise<DrawnPicture | 'unavailable' | null> {
    const path = want.group
    const data = await this.deps.vault.readBinary(path)
    const win = this.deps.doc.defaultView
    if (!win) return null
    if (/\.svg$/i.test(path)) return this.drawSvg(data)
    let bitmap: ImageBitmap
    try {
      bitmap = await win.createImageBitmap(new Blob([data]), {
        resizeWidth: IMAGE_PICTURE_WIDTH,
        resizeQuality: 'medium',
      })
    } catch {
      // Not an image this WebView decodes: the card says so itself.
      return 'unavailable'
    }
    try {
      if (!(await this.deps.slices.next())) return null
      return { canvas: this.paint(bitmap), meta: null }
    } finally {
      bitmap.close()
    }
  }

  /** An SVG, drawn at the picture's width through an image element —
   * loaded from a data URL, which leaves the canvas readable. */
  private async drawSvg(
    data: ArrayBuffer,
  ): Promise<DrawnPicture | 'unavailable' | null> {
    const doc = this.deps.doc
    const img = doc.createElement('img')
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
      new TextDecoder().decode(data),
    )}`
    try {
      await img.decode()
    } catch {
      return 'unavailable'
    }
    if (!(await this.deps.slices.next())) return null
    return { canvas: this.paint(img), meta: null }
  }

  /** `source` on a canvas the picture's width, and no taller than a
   * picture may be. */
  private paint(source: ImageBitmap | HTMLImageElement): HTMLCanvasElement {
    const naturalWidth =
      'naturalWidth' in source ? source.naturalWidth : source.width
    const naturalHeight =
      'naturalHeight' in source ? source.naturalHeight : source.height
    // An SVG with no size of its own reports none: drawn square.
    const aspect =
      naturalWidth > 0 && naturalHeight > 0 ? naturalHeight / naturalWidth : 1
    let width = IMAGE_PICTURE_WIDTH
    let height = Math.max(1, Math.round(width * aspect))
    if (height > IMAGE_PICTURE_MAX_HEIGHT) {
      width = Math.max(1, Math.round(IMAGE_PICTURE_MAX_HEIGHT / aspect))
      height = IMAGE_PICTURE_MAX_HEIGHT
    }
    const canvas = this.deps.doc.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.getContext('2d')?.drawImage(source, 0, 0, width, height)
    return canvas
  }
}
