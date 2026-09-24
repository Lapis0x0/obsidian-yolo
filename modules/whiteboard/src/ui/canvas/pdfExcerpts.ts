// Excerpting from a PDF onto the board it is read on: a quote, or a framed
// area as a picture, becomes bare text written on the board
// (../../domain/excerpt.ts has the markdown and why) citing its page with
// Obsidian's own link.
//
// Bare text rather than a card: an excerpt is a line taken down beside the
// reading, not a document of its own, and a frame around every one of them
// turned a board of notes into a board of boxes. It is still a text node — it
// turns into a card from its menu, and a reader that does not know bare text
// shows it as one (fileFormat.ts's `TextDisplay`).
//
// An excerpt is only text. Nothing binds it to the PDF, to a highlight it
// may have been taken from, or to the annotation file: the drag that made
// it may leave the passage marked (../pdf/annotationController.ts), but
// deleting either never touches the other (design.md §0). It is undone like
// anything made on the board.
//
// Where it goes: dropped, where it was dropped; otherwise beside the PDF card
// it came from — the column right of the card, the next free slot down
// (../../domain/placement.ts's `placeBeside`), so a run of excerpts from one
// PDF stacks there rather than piling up or wandering off. The card is not
// selected: selecting it would take the focus off the PDF card, and with it
// the text layers the reader is reading on. It is announced only when it
// landed out of sight.

import {
  type ExcerptCardMetrics,
  type ExcerptContent,
  type TextExcerpt,
  areaExcerptCardSize,
  areaExcerptFileName,
  areaExcerptMarkdown,
  textExcerptCardSize,
  textExcerptMarkdown,
} from '../../domain/excerpt'
import type {
  Board,
  BoardNode,
  NodeId,
  TextNode,
} from '../../domain/fileFormat'
import { basenameWithoutExtension } from '../../domain/naming'
import type { PdfRectTuple } from '../../domain/pdfAnnotations'
import {
  type Point,
  type Rect,
  collectObstacles,
  placeBeside,
  placeCard,
} from '../../domain/placement'
import { GRID_WORLD_STEP_PX, NEW_EMBED_CARD_SIZE } from '../constants'
import { generatePdfLink } from '../pdf/pdfLink'
import type { PdfReader } from '../pdf/pdfReader'

export type PdfExcerptsCallbacks = Readonly<{
  getBoard: () => Board
  /** False on a board that cannot take a new card right now. */
  canCreate: () => boolean
  /** The PDF card a reader is showing: the card's own, or the one the
   * reading panel was opened on. */
  pdfNodeForReader: (reader: PdfReader) => NodeId | null
  nextNodeId: (board: Board) => NodeId
  /** Puts the card on the board as one undoable step. */
  addCard: (node: TextNode) => void
  /** Whether a world rectangle is wholly in view. */
  isInView: (rect: Rect) => boolean
  /** The board's path: what the links in a card are written relative to,
   * and where its attachments are filed from. */
  getSourcePath: () => string
  t: (key: string) => string
  reportError: (stage: string, error: unknown) => void
}>

/** An excerpt is made at the width bare text grows to on its own
 * (styles/cards/text.css), and as tall as it is estimated to come out — an
 * estimate its first layout replaces (cardRenderer.ts's `observeText`), so
 * it is only ever what the landing slot and the first frame show. */
const METRICS: ExcerptCardMetrics = {
  width: NEW_EMBED_CARD_SIZE.w,
  grid: GRID_WORLD_STEP_PX,
  minHeight: 2 * GRID_WORLD_STEP_PX,
  maxHeight: Number.POSITIVE_INFINITY,
}

/** An area is drawn at about twice the card's width in pixels, so a card
 * showing it at its width is sharp on a high-density screen... */
const AREA_TARGET_PX = 2 * NEW_EMBED_CARD_SIZE.w
/** ...but never below scale 2 (a small formula stays legible when the card
 * is enlarged), never above 4, and never past this many pixels a side. */
const AREA_MIN_SCALE = 2
const AREA_MAX_SCALE = 4
const AREA_MAX_SIDE_PX = 4096

export class PdfExcerpts {
  constructor(
    private readonly host: YoloModuleHostApiV1,
    private readonly callbacks: PdfExcerptsCallbacks,
  ) {}

  /**
   * A quote as a card: centred on `at` (world) when it was dropped there,
   * else beside its PDF card. False when nothing was made.
   */
  addText(reader: PdfReader, excerpt: TextExcerpt, at?: Point): boolean {
    const { callbacks } = this
    if (!callbacks.canCreate()) return false
    const link = generatePdfLink(this.host, callbacks.t, {
      pdfPath: reader.path,
      sourcePath: callbacks.getSourcePath(),
      page: excerpt.page,
      selection: excerpt.selection,
    })
    if (!link) return false
    this.place(
      reader,
      textExcerptMarkdown(excerpt.quote, link),
      textExcerptCardSize(excerpt.quote, METRICS),
      at,
    )
    return true
  }

  /**
   * A framed area as a card: the region drawn to a PNG, filed where the
   * user's attachment setting files a picture pasted into a note written at
   * the board's path, and embedded above a link to its page. Placed as a
   * quote is.
   */
  async addArea(
    reader: PdfReader,
    page: number,
    rect: PdfRectTuple,
    at?: Point,
  ): Promise<boolean> {
    const { callbacks } = this
    if (!callbacks.canCreate()) return false
    const sourcePath = callbacks.getSourcePath()
    try {
      const bytes = await reader.renderRegion(page, rect, areaScale(rect))
      const size = pngSize(bytes)
      const path = await this.host.vault.getAvailableAttachmentPath(
        areaExcerptFileName(
          basenameWithoutExtension(reader.path),
          page,
          new Date(),
        ),
        sourcePath,
      )
      await this.host.vault.createBinary(path, bytes)
      const imageLink = this.host.vault.generateLink(path, sourcePath)
      const pageLink = generatePdfLink(this.host, callbacks.t, {
        pdfPath: reader.path,
        sourcePath,
        page,
      })
      // The board may have been closed, or broken, while the picture was
      // being drawn and written; the attachment stays, as a pasted one would.
      if (!imageLink || !pageLink || !callbacks.canCreate()) return false
      this.place(
        reader,
        areaExcerptMarkdown(imageLink, pageLink),
        areaExcerptCardSize(size, METRICS),
        at,
      )
      return true
    } catch (error) {
      callbacks.reportError('pdf area excerpt', error)
      this.host.ui.notice(callbacks.t('pdf.excerpt.failed'))
      return false
    }
  }

  /**
   * Where a card made from `content` and dropped at `at` (world) would be:
   * the rectangle `place` gives it, for the board to show while it is still
   * being dragged.
   */
  landing(content: ExcerptContent, at: Point): Rect {
    const size =
      content.kind === 'text'
        ? textExcerptCardSize(content.quote, METRICS)
        : areaExcerptCardSize(areaPictureSize(content.rect), METRICS)
    return { ...centredOn(at, size), w: size.w, h: size.h }
  }

  private place(
    reader: PdfReader,
    text: string,
    size: Readonly<{ w: number; h: number }>,
    at?: Point,
  ): void {
    const { callbacks } = this
    const board = callbacks.getBoard()
    const position = at
      ? centredOn(at, size)
      : this.besideSource(board, reader, size)
    const node: TextNode = {
      id: callbacks.nextNodeId(board),
      type: 'text',
      x: Math.round(position.x),
      y: Math.round(position.y),
      w: size.w,
      h: size.h,
      text,
      plain: true,
      extra: {},
    }
    callbacks.addCard(node)
    if (!at && !callbacks.isInView(node)) {
      this.host.ui.notice(callbacks.t('pdf.excerpt.addedOutOfView'))
    }
  }

  private besideSource(
    board: Board,
    reader: PdfReader,
    size: Readonly<{ w: number; h: number }>,
  ): Point {
    const obstacles = collectObstacles(board.nodes)
    const sourceId = this.callbacks.pdfNodeForReader(reader)
    const source: BoardNode | undefined =
      sourceId === null
        ? undefined
        : board.nodes.find((node) => node.id === sourceId)
    return source
      ? placeBeside(obstacles, size, source)
      : placeCard(obstacles, size)
  }
}

/** Where a card of `size` sits to be centred on `at`. */
function centredOn(at: Point, size: Readonly<{ w: number; h: number }>): Point {
  return { x: at.x - size.w / 2, y: at.y - size.h / 2 }
}

/** The picture `addArea` draws for an area, sized before it is drawn. */
function areaPictureSize(rect: PdfRectTuple): {
  width: number
  height: number
} {
  const scale = areaScale(rect)
  return {
    width: Math.round(Math.abs(rect[2] - rect[0]) * scale),
    height: Math.round(Math.abs(rect[3] - rect[1]) * scale),
  }
}

/** The render scale for an area: see AREA_TARGET_PX. */
function areaScale(rect: PdfRectTuple): number {
  const width = Math.abs(rect[2] - rect[0])
  const height = Math.abs(rect[3] - rect[1])
  const wanted = width > 0 ? AREA_TARGET_PX / width : AREA_MIN_SCALE
  const scale = Math.min(AREA_MAX_SCALE, Math.max(AREA_MIN_SCALE, wanted))
  const side = Math.max(width, height)
  return side > 0 ? Math.min(scale, AREA_MAX_SIDE_PX / side) : scale
}

/** A PNG's pixel size, from its header (the IHDR chunk always comes first). */
function pngSize(bytes: ArrayBuffer): { width: number; height: number } {
  if (bytes.byteLength < 24) return { width: 0, height: 0 }
  const view = new DataView(bytes)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}
