// Pictures of cards (./pictures.ts's source 'card'): a text card, bare text,
// a note — what its content looks like, so that zoomed out the overview
// shows the card rather than a grey block with its title. A group is a board,
// a picture one of its cards, and its stamp is the card's signature joined
// with the style environment's (./cardSignature.ts, ./pictureStyles.ts).
//
// A picture is taken of the card's own DOM: copied (../export/domCopy.ts),
// put in an SVG `<foreignObject>` with the shared stylesheet, loaded as an
// image and drawn onto a canvas. Only the card's content is in it — the
// card's background, colour, border and selection stay out, and are drawn
// around it by whoever shows it — so it can stand in for the content
// whatever the card's colour or state. It covers the card's whole box, its
// (transparent) border included.
//
// Loaded from a data URL, never a blob URL: Chromium counts an SVG holding
// a `<foreignObject>` as another origin's when it comes from a blob, and the
// canvas it is drawn on could not be read back to be kept. Parsing and
// drawing it is main-thread work, in two short steps, each in an idle slice
// (./idle.ts) — never in a frame with something else to do, never while the
// board moves, never with the window in the background.
//
// A card is taken once its content has been quiet for a moment
// (`QUIET_MS`, as an export waits): what renders after its text — an image
// arriving, a diagram — is in the picture. Never a card being edited or
// written into. The picture is as sharp as the overview ever shows the card
// (OVERVIEW_RESTORE_SCALE at the display's density), and never more than
// `MAX_PIXELS`, which a long bare text would otherwise run far past.

import type { BoardNode } from '../../domain/fileFormat'
import type { PictureStore } from '../../host/pictureStore'
import { OVERVIEW_RESTORE_SCALE } from '../constants'
import { COPY_CSS, blobToDataUrl, copyDom } from '../export/domCopy'

import type { IdleSlices } from './idle'
import type {
  DrawnPicture,
  PictureRef,
  PictureSource,
  PictureTurn,
  WantedPicture,
} from './pictures'
import { PICTURE_FRAME_CLASS, type PictureStyles } from './pictureStyles'

const SVG_NS = 'http://www.w3.org/2000/svg'
/** How long a card's content must have changed nothing before it is taken,
 * in milliseconds: what renders after its text arrives over several
 * frames. */
const QUIET_MS = 150
/** How long a card is waited on at most: one whose content never settles is
 * not taken until it changes. */
const QUIET_TIMEOUT_MS = 4000
/** The most pixels a card's picture has. */
const MAX_PIXELS = 400_000
/** Images inlined into pictures, kept for the next picture that shows the
 * same one at the same size. */
const INLINED_IMAGES_KEPT = 48

/** The picture's scaffolding, laid over the shared stylesheet. The card's
 * own box is kept — its size, its padding, its (now transparent) border —
 * and only what is drawn around the content is taken off. */
const FILL_CLASS = 'yolo-whiteboard-picture-fill'
const WORLD_CLASS = 'yolo-whiteboard-picture-world'
const PICTURE_CSS = `
.${PICTURE_FRAME_CLASS} { position: relative; overflow: hidden; background: none; }
.${FILL_CLASS} { position: absolute; inset: 0; background: none !important; overflow: visible; }
.${WORLD_CLASS} { position: absolute !important; left: 0; top: 0; transform: none !important; }
.${WORLD_CLASS} > .yolo-whiteboard-card { left: 0 !important; top: 0 !important; background: none !important; border-color: transparent !important; box-shadow: none !important; }
${COPY_CSS}`

/** Taken out of a card's copy: what stands beside the content rather than
 * being it — its title, the block it shows while it has no content, the
 * prompts of an empty card, a picture standing in for it. */
const CARD_CHROME = [
  '.yolo-whiteboard-card-title',
  '.yolo-whiteboard-card-title-block',
  '.yolo-whiteboard-card-chips',
  '.yolo-whiteboard-card-picture',
].join(',')

/** The picture of card `id` of the board at `boardPath`. */
export function cardRef(boardPath: string, id: string): PictureRef {
  return { source: 'card', group: boardPath, key: id }
}

export type CardPicturesDeps = Readonly<{
  store: PictureStore
  doc: Document
  slices: IdleSlices
  styles: PictureStyles
  /** Whether a picture may be started now (./idle.ts's `ready`). */
  ready: () => boolean
  getNode: (id: string) => BoardNode | undefined
  /** A card's element, when it is mounted with its content built and
   * nothing — an editor, a generation — owns it; null otherwise. */
  mounted: (id: string) => HTMLElement | null
  /** The board's root element's classes and the world layer's: the
   * picture's copy sits under the same, so the same rules reach it. */
  rootClass: string
  worldClass: string
  reportError: (stage: string, error: unknown) => void
}>

export class CardPictures implements PictureSource {
  readonly id = 'card' as const
  readonly label = 'card picture'
  readonly store: PictureStore
  readonly turn: PictureTurn
  private readonly inlined = new Map<string, Promise<string | null>>()

  constructor(private readonly deps: CardPicturesDeps) {
    this.store = deps.store
    // The scheduler asks once a frame; nothing has to be woken.
    this.turn = {
      begin: () => deps.ready(),
      end: () => undefined,
      withdraw: () => undefined,
    }
  }

  /** A board's cards are one group for as long as it is the board: each
   * picture says by its stamp whether it is still its card's. */
  version(boardPath: string): number | null {
    return boardPath === '' ? null : 0
  }

  /** Only a mounted card whose content is built can be taken. */
  canDraw(want: WantedPicture): boolean {
    return this.deps.mounted(want.key) !== null
  }

  async draw(
    want: WantedPicture,
    _version: number,
  ): Promise<DrawnPicture | 'unavailable' | null> {
    const el = this.deps.mounted(want.key)
    if (!el) return null
    const quiet = await waitQuiet(el, this.deps.doc)
    if (!quiet) return 'unavailable'
    // Taken off the board, or opened for editing, while it settled.
    if (this.deps.mounted(want.key) !== el) return null
    const node = this.deps.getNode(want.key)
    if (!node) return null
    const canvas = await this.capture(el, node.w, node.h)
    if (canvas && this.deps.mounted(want.key) !== el) {
      canvas.width = 0
      canvas.height = 0
      return null
    }
    return canvas ? { canvas, meta: null } : null
  }

  /**
   * A picture of `el`, a card `width` by `height` world units: its content,
   * on a transparent canvas the picture's size. Null when the board was
   * closed, or the style environment changed, on the way.
   */
  private async capture(
    el: HTMLElement,
    width: number,
    height: number,
  ): Promise<HTMLCanvasElement | null> {
    const { doc, slices, styles } = this.deps
    const win = doc.defaultView
    if (!win) return null
    const scale = Math.min(
      OVERVIEW_RESTORE_SCALE * (win.devicePixelRatio || 1),
      Math.sqrt(MAX_PIXELS / Math.max(1, width * height)),
    )
    const pixelWidth = Math.max(1, Math.round(width * scale))
    const pixelHeight = Math.max(1, Math.round(height * scale))

    // 1. The copy, read off the live card in a slice of its own.
    if (!(await slices.next())) return null
    const { copy, finish } = copyDom(el, {
      image: (src, cssWidth) =>
        this.inlineImage(src, Math.max(1, Math.round(cssWidth * scale))),
    })
    for (const chrome of Array.from(copy.querySelectorAll(CARD_CHROME))) {
      chrome.remove()
    }
    copy.classList.remove('yolo-whiteboard-card-body-loading')
    for (const loading of Array.from(
      copy.querySelectorAll('.yolo-whiteboard-card-body-loading'),
    )) {
      loading.classList.remove('yolo-whiteboard-card-body-loading')
    }
    copy.style.width = `${width}px`
    copy.style.height = `${height}px`
    const frame = doc.createElement('div')
    const style = doc.createElement('style')
    const root = doc.createElement('div')
    root.className = `${this.deps.rootClass} ${FILL_CLASS}`
    const viewport = doc.createElement('div')
    viewport.className = `yolo-whiteboard-viewport ${FILL_CLASS}`
    const world = doc.createElement('div')
    world.className = `${this.deps.worldClass} ${WORLD_CLASS}`
    world.appendChild(copy)
    viewport.appendChild(world)
    root.appendChild(viewport)
    frame.append(style, root)
    frame.style.width = `${width}px`
    frame.style.height = `${height}px`
    await finish()

    // 2. Its stylesheet, its SVG, loaded as an image. The frame wears the
    //    body's classes, which is where a theme's rules start from.
    if (!(await slices.next())) return null
    const env = styles.environment
    if (!env) return null
    frame.className = `${env.bodyClass} ${PICTURE_FRAME_CLASS}`
    const css = await styles.sheetFor(frame)
    if (css === null) return null
    style.textContent = `${css}\n${PICTURE_CSS}`
    const svg = doc.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('width', String(pixelWidth))
    svg.setAttribute('height', String(pixelHeight))
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
    svg.setAttribute('preserveAspectRatio', 'none')
    const object = doc.createElementNS(SVG_NS, 'foreignObject')
    object.setAttribute('width', String(width))
    object.setAttribute('height', String(height))
    object.appendChild(frame)
    svg.appendChild(object)
    const image = doc.createElement('img')
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
      new XMLSerializer().serializeToString(svg),
    )}`
    try {
      await image.decode()
    } catch (error) {
      this.deps.reportError('card picture decode', error)
      return null
    }

    // 3. Drawn: the SVG is laid out and painted here, in a slice of its own.
    if (!(await slices.next())) return null
    const canvas = doc.createElement('canvas')
    canvas.width = pixelWidth
    canvas.height = pixelHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(image, 0, 0, pixelWidth, pixelHeight)
    // What `drawImage` only records is done now, in this slice, rather than
    // whenever the canvas is next read.
    ctx.getImageData(0, 0, 1, 1)
    image.src = ''
    return canvas
  }

  /** An image in a card, `width` pixels wide as the picture shows it, as a
   * data URL: scaled down first, so a photo in a note costs a picture a few
   * kilobytes rather than its whole file. */
  private inlineImage(src: string, width: number): Promise<string | null> {
    const key = `${width}\n${src}`
    const known = this.inlined.get(key)
    if (known) return known
    const made = this.scaledImage(src, width)
    if (this.inlined.size >= INLINED_IMAGES_KEPT) this.inlined.clear()
    this.inlined.set(key, made)
    return made
  }

  private async scaledImage(
    src: string,
    width: number,
  ): Promise<string | null> {
    const win = this.deps.doc.defaultView
    if (!win) return null
    try {
      // Not `requestUrl`: what is fetched is the card's own image — an
      // `app://` vault file the board already loaded — and the Host API
      // offers modules no network surface to ask instead.
      const response = await win.fetch(src)
      if (!response.ok) return null
      const blob = await response.blob()
      if (blob.type === 'image/svg+xml') return await blobToDataUrl(blob, win)
      const bitmap = await win.createImageBitmap(blob, {
        resizeWidth: width,
        resizeQuality: 'medium',
      })
      const canvas = this.deps.doc.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
      bitmap.close()
      const encoded = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/webp', 0.85),
      )
      canvas.width = 0
      canvas.height = 0
      return encoded ? await blobToDataUrl(encoded, win) : null
    } catch {
      // Not loadable from here (another origin's, gone): the picture shows
      // the card without it, as an export does.
      return null
    }
  }
}

/** Resolves once `el` has changed nothing for `QUIET_MS`: true then, false
 * if it is still changing after `QUIET_TIMEOUT_MS`. */
function waitQuiet(el: HTMLElement, doc: Document): Promise<boolean> {
  const win = doc.defaultView
  if (!win) return Promise.resolve(false)
  return new Promise((resolve) => {
    const started = win.performance.now()
    let changedAt = started
    const observer = new win.MutationObserver(() => {
      changedAt = win.performance.now()
    })
    observer.observe(el, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    })
    const check = (): void => {
      const now = win.performance.now()
      if (now - changedAt >= QUIET_MS) {
        observer.disconnect()
        resolve(true)
        return
      }
      if (now - started >= QUIET_TIMEOUT_MS) {
        observer.disconnect()
        resolve(false)
        return
      }
      win.setTimeout(check, QUIET_MS - (now - changedAt))
    }
    win.setTimeout(check, QUIET_MS)
  })
}
