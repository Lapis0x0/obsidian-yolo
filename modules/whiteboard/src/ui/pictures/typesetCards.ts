// Pictures of cards (./pictures.ts's source 'card'): a text card, bare text,
// a note — its content as the card shows it, so that zoomed out the overview
// shows what is written on each card rather than a grey block.
//
// Typeset rather than taken: the card's markdown is laid out and drawn by the
// board's own typesetter (../../typeset/), in the look read off a card the
// host rendered (./typesetStyle.ts). A picture is a pure function of the
// card's source, its size and that look, all of which its stamp names — so
// it is right exactly when its stamp is, and costs a few milliseconds to
// make again. Which is why none is kept on the device: there is nothing to
// save by reading one back, and nothing to go stale there.
//
// Drawn by the board's typesetting worker (../typesetting/), in the fonts
// the document has — a theme's web fonts included, which the worker is
// handed — and handed back as a bitmap: nothing of it is on the main thread
// but reading a note.
//
// Only the content is drawn — the card's background, colour, border and
// selection are drawn around it by whoever shows it — over the card's whole
// box, its border included, as wide as the overview ever shows it
// (OVERVIEW_RESTORE_SCALE at the display's density) and never more than
// `MAX_PIXELS`.

import { resolveColor } from '../../domain/color'
import { type BoardNode, isPlainText } from '../../domain/fileFormat'
import { fileNodeKind } from '../../domain/naming'
import { clippedCardMarkdown } from '../canvas/cardContent'
import { OVERVIEW_RESTORE_SCALE } from '../constants'
import type { TypesetClient } from '../typesetting/typesetClient'

import type {
  DrawnPicture,
  PictureRef,
  PictureSource,
  PictureTurn,
  WantedPicture,
} from './pictures'
import type { TypesetStyle } from './typesetStyle'

/** The most pixels a card's picture has. */
const MAX_PIXELS = 400_000
/** How far above a framed card's bottom edge its content fades out — the
 * card's content mask (styles/cards/content.css). */
const FADE = 24
/** Raised whenever a change to the typesetter changes what a picture looks
 * like, so that pictures made before it are made again. */
const TYPESET_VERSION = 2

/** A card picture's stamp: its card's signature (./cardSignature.ts) and
 * the look it is typeset in. */
export function cardStamp(
  signature: string,
  styleHash: string,
  /** The web images' sizes as known (../../host/remoteImageSizes.ts): a
   * picture made before one was may have left it out. */
  imagesRevision: number,
): string {
  return `${signature}.${styleHash}.${TYPESET_VERSION}.${imagesRevision}`
}

/** The picture of card `id` of the board at `boardPath`. */
export function cardRef(boardPath: string, id: string): PictureRef {
  return { source: 'card', group: boardPath, key: id }
}

export type TypesetCardsDeps = Readonly<{
  doc: Document
  typesetter: TypesetClient
  style: TypesetStyle
  /** Whether a picture may be started now (./idle.ts's `ready`). */
  ready: () => boolean
  getNode: (id: string) => BoardNode | undefined
  /** The card on the board a picture is of; null when none is. */
  idOf: (want: PictureRef) => string | null
  /** A note's text; null when it cannot be read. */
  readNote: (path: string) => Promise<string | null>
  /** A node colour as the board paints it (root.css's palette). */
  colorOf: (color: string) => string | null
  /** The own sizes of the images `markdown` embeds, by what it names
   * each, as far as they are known (../gpu/imageSizes.ts). */
  imagesOf: (
    markdown: string,
  ) => Promise<Record<string, Readonly<{ w: number; h: number }>>>
}>

export class TypesetCards implements PictureSource {
  readonly id = 'card' as const
  readonly label = 'card picture'
  /** Made in the worker, which takes them one after another: a few asked
   * at once so that it is never waiting on the main thread between them. */
  readonly concurrency = 4
  readonly turn: PictureTurn

  constructor(private readonly deps: TypesetCardsDeps) {
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

  canDraw(want: WantedPicture): boolean {
    return (
      this.deps.idOf(want) !== null &&
      this.deps.style.tokens !== null &&
      this.deps.typesetter.usable
    )
  }

  async draw(
    want: WantedPicture,
    _version: number,
  ): Promise<DrawnPicture | 'unavailable' | null> {
    const { deps } = this
    const id = deps.idOf(want)
    if (id === null) return null
    const node = deps.getNode(id)
    if (!node) return null
    let markdown: string | null
    if (node.type === 'text') markdown = node.text
    else if (node.type === 'file' && fileNodeKind(node.file) === 'markdown') {
      markdown = await deps.readNote(node.file)
    } else return 'unavailable'
    if (markdown === null) return 'unavailable'
    // Changed while its note was read: asked for again, as it now is.
    if (deps.getNode(id) !== node) return null
    const tokens = deps.style.tokens
    const hash = deps.style.hash
    if (!tokens || hash === null || !want.stamp.includes(`.${hash}.`)) {
      return null
    }
    const win = deps.doc.defaultView
    if (!win) return null
    const scale = Math.min(
      OVERVIEW_RESTORE_SCALE * (win.devicePixelRatio || 1),
      Math.sqrt(MAX_PIXELS / Math.max(1, node.w * node.h)),
    )
    const plain = isPlainText(node)
    const clipped = clippedCardMarkdown(node, markdown)
    // Its images take their room, as the card's do.
    const images = await deps.imagesOf(clipped)
    const image = await deps.typesetter.picture(
      { tokens, hash },
      {
        id,
        markdown: clipped,
        images,
        w: node.w,
        h: node.h,
        plain,
        color:
          plain && node.color !== undefined ? deps.colorOf(node.color) : null,
      },
      scale,
      plain ? 0 : FADE,
    )
    return { image, meta: null }
  }
}

/** A node colour (JSON Canvas `color`) as a colour the canvas paints with,
 * read off the board's root, where the palette lives. */
export function nodeColorFrom(root: HTMLElement) {
  return (color: string): string | null => {
    const resolved = resolveColor(color)
    if (resolved.kind === 'none') return null
    if (resolved.kind === 'custom') return resolved.hex
    const win = root.ownerDocument.defaultView
    const value = win
      ?.getComputedStyle(root)
      .getPropertyValue(`--yolo-whiteboard-color-${resolved.preset}`)
      .trim()
    return value ? value : null
  }
}
