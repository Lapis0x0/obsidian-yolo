// The content of the board's text and note cards, drawn by the GPU scene
// (./scene.ts) wherever the overview canvas (../canvas/overviewLayer.ts)
// draws those cards — in its tier, and under the world for cards not mounted
// yet — in place of their pictures: typeset (../../typeset/) in the look read
// off the host's own card (../pictures/typesetStyle.ts), sharp at the size
// the card shows at rather than a picture made at one size.
//
// The overview layer decides which cards show, as it always has; this layer
// only answers, card by card, whether it can draw one (`claim`): it cannot
// while the card is not typeset yet, or where its type would be too small to
// read, and there the card's picture stands in as before.
//
// Its canvas lies between the overview's and the world layer, so the content
// is over the surfaces the overview draws and under everything the world
// holds.
//
// Where WebGL2 is not there, its context is lost, or the typesetting worker
// cannot start, it draws nothing and claims nothing: every card shows as it
// does without it — its DOM near to, its picture far away.

import { resolveColor } from '../../domain/color'
import { type BoardNode, isPlainText } from '../../domain/fileFormat'
import { fileNodeKind } from '../../domain/naming'
import type { CardRect } from '../../domain/resize'
import type { CanvasView } from '../../domain/virtualization'
import type { PictureStore } from '../../host/pictureStore'
import { imageTargets, isRemoteImage } from '../../typeset/images'
import { type MathLayout, type MathSource, mathKey } from '../../typeset/math'
import { type TypesetTokens, contentClip } from '../../typeset/tokens'
import { clippedCardMarkdown, readingOffset } from '../canvas/cardContent'
import type { ContentLayer } from '../canvas/overviewLayer'
import {
  OVERVIEW_THEMED_BORDER_ALPHA,
  OVERVIEW_THEMED_CARD_WASH_ALPHA,
  WHEEL_PAN_GLIDE_TAU_MS,
} from '../constants'
import type { TypesetStyle } from '../pictures/typesetStyle'
import {
  type KeptBytes,
  TYPESET_GROUP_VERSION,
  decodePack,
  decodeTypeset,
  encodePacks,
  encodeTypeset,
  packKey,
  typesetStamp,
} from '../typesetting/typesetCache'
import type { Look, TypesetClient } from '../typesetting/typesetClient'
import {
  type TypesetCard,
  type TypesetResult,
  type TypesetResultCard,
  parseKey,
} from '../typesetting/typesetProtocol'

import type { ImageSizes } from './imageSizes'
import { GLYPH_WORDS, packColor } from './instances'
import type { DrawnText } from './passages'
import { type PageSize, firstPage, isScenePdf, pdfCardImages } from './pdfCards'
import {
  type CardImage,
  GpuScene,
  type ImagePicture,
  type SceneFrame,
} from './scene'

/** How far above a framed card's bottom edge its content fades out
 * (styles/cards/content.css's fade). */
const FADE = 24
/** How long the camera must have been still to count as at rest, ms. */
const SETTLE_MS = 120
/** The smallest a card's body type is drawn, in device pixels: below it
 * each run is drawn as a bar (./instances.ts's `greekBar`), for far less. */
const MIN_BODY_DEVICE_PX = 5
/** A card's corners (styles/cards/card.css), and its border and a
 * selected one's, at least that many CSS pixels wide however far away. */
const CARD_RADIUS = 10
const CARD_BORDER = 1
const SELECTED_BORDER = 2

/** Cards a call to the worker typesets, and calls in flight at once: few
 * enough that what the overview asks for next is not queued behind the
 * whole board. */
const BATCH = 32
const IN_FLIGHT = 2
/** How long after the cards kept last change they are written back: a
 * board's cards come in batch after batch, and are written as one. */
const KEEP_DELAY_MS = 2000

export type GpuBoardDeps = Readonly<{
  /** Where the scene's canvas goes: appended after the overview's, before
   * the world layer is. */
  parent: HTMLElement
  /** Where the board's palette is read (root.css). */
  root: HTMLElement
  style: TypesetStyle
  view: () => CanvasView
  /** Whether a card has its DOM now. The overview leaves a card it drew
   * under the world for its DOM to cover when it mounts, and does not draw
   * again for that; bare text's DOM is transparent and would not cover this
   * layer's drawing, so a mounted card is dropped here. */
  isMounted: (id: string) => boolean
  isSelected: (id: string) => boolean
  /** Cards were typeset anew: what reaches a passage in them is placed
   * again (./passages.ts). */
  onTypeset: (ids: readonly string[]) => void
  /** Has the overview draw again: it asks anew which cards this layer
   * draws. */
  redrawOverview: () => void
  readNote: (path: string) => Promise<string | null>
  /** An image file's picture (../pictures/imageFiles.ts), or a PDF page's
   * (./pdfCards.ts's `pdfPageKey`), null while it has none. */
  imagePicture: ImagePicture
  /** The size of a PDF page's picture, null while it has none: what a PDF
   * card's pages are laid out by (./pdfCards.ts). */
  pagePicture: (file: string, page: number) => PageSize | null
  /** The own sizes of the images cards embed. */
  images: ImageSizes
  /** The board's typesetting worker (../typesetting/typesetClient.ts). */
  typesetter: TypesetClient
  /** Where typeset cards are kept on this device, and the board's group
   * there — its path, empty while it has none (../typesetting/
   * typesetCache.ts); null to keep none. */
  cache: Readonly<{ store: PictureStore; group: () => string }> | null
  /** Formulas laid out by the host's math engine (`host.math.layout`). */
  layoutMath: (
    formulas: readonly MathSource[],
  ) => Promise<readonly (MathLayout | null)[]>
  reportError: (stage: string, error: unknown) => void
  /** The card being read moved under its frame (`scrollBy`): what is
   * placed in it is placed again. */
  onScroll: (id: string) => void
}>

/** The card being read (`setReading`): its whole note typeset, and moved
 * up under its frame by the wheel. */
type Reading = {
  id: string
  /** How far its content is moved up now, and where the wheel is taking
   * it. */
  scroll: number
  target: number
  /** Whether what it has placed is its whole note rather than its window:
   * until then it moves within its window. */
  full: boolean
  /** Whether its whole note holds what only the host's renderer shows: it
   * is read in its DOM preview then, not here (`drawable`). */
  host: boolean
  /** A source line it was asked to be turned to before its whole note came
   * (`readAt`): the block that line is in goes to its top then. */
  goto: number | null
  /** When the glide last stepped, 0 while it is at rest. */
  lastTime: number
}

/** Where a placed card's blocks are (../../typeset/layout.ts's `blocks`),
 * their lines counted from `from`, the line it was typeset from; and where
 * its content ends. */
type Placed = Readonly<{ from: number; blocks: readonly number[]; end: number }>

/** The thumb of the card being read: 8 units of gutter with the thumb 2 in
 * from each side, as styles/cards/content.css draws the DOM preview's. */
const THUMB_GUTTER = 8
const THUMB_INSET = 2
const THUMB_MIN = 18

/** A card owed its content: a note's text is read first. */
type Pending = {
  node: BoardNode
  text: string | null
  reading: boolean
  /** What it is kept under once its input is known (`placeKept`). */
  stamp?: string
}

/** A card on its way to be placed, and what it was typeset from. */
type Sent = Readonly<{
  pending: Pending
  card: TypesetCard
  paths: Record<string, string>
}>

/** Narrower than this on screen a card shows no picture: the overview's
 * own threshold (../canvas/overviewLayer.ts). */
const PICTURE_MIN_SCREEN_PX = 4

export class GpuBoard implements ContentLayer {
  readonly canvas: HTMLCanvasElement
  private readonly scene: GpuScene
  private readonly nodes = new Map<string, BoardNode>()
  /** Cards whose content is owed, in the order they are typeset. */
  private readonly pending = new Map<string, Pending>()
  private inFlight = 0
  /** Counts the looks typeset in: a result for an older one is dropped. */
  private generation = 0
  private lastView: CanvasView | null = null
  private movedAt = 0
  private dirty = true
  private styleHash: string | null = null
  /** Has the scene draw again: a picture it shows arrived. */
  markDirty(): void {
    this.dirty = true
  }

  /** What the overview's last frame had this layer draw, and where. */
  private claimed = new Map<string, CardRect>()
  /** The overview claimed afresh since the scene last followed it
   * (`syncShown`): what it claims only changes when it draws again — the
   * camera, the selection, a mount, the look — so a board at rest has
   * nothing to follow. */
  private claimsChanged = true
  /** What the scene shows now. */
  private shown = new Set<string>()
  /** The board's palette as RGBA8 words, read once a look. */
  private palette: Palette | null = null
  private readonly colorCtx: CanvasRenderingContext2D
  /** Cards asked for that are not typeset yet: typeset first. */
  private readonly wanted = new Set<string>()
  /** The typeset cards that hold only what the typesetter draws: what may
   * be drawn rather than built at any zoom (`drawable`). */
  private readonly drawables = new Set<string>()
  /** Each typeset card's text as drawn, for its passages. */
  private readonly texts = new Map<string, DrawnText>()
  /** Each typeset card's images: which file, and where in the card. */
  private readonly cardImages = new Map<string, readonly CardImage[]>()
  private drawableRevision = 0
  /** The cards that embed an image on the web, by its address: typeset
   * again when what is known of it changes (`imageLearned`). */
  private readonly remoteWaits = new Map<string, Set<string>>()
  /** Cards whose content changed since they were last typeset: what the
   * scene has of them is out of date, so they are built until it is not.
   * A new look does not count — the old one is near enough meanwhile. */
  private readonly changed = new Set<string>()
  /** The board's cards as this device keeps them, once read (`keptReady`),
   * for the group read. */
  private kept = new Map<string, KeptBytes>()
  private keptGroup: string | null = null
  private keptLoading = false
  private keepTimer: ReturnType<typeof setTimeout> | null = null
  /** Formulas as the host laid them out, by ../../typeset/math.ts's
   * `mathKey` — null for one it could not — or asked for and not back. */
  private readonly formulas = new Map<string, MathLayout | null | 'asked'>()
  /** Each card's formulas, as the worker found them: what it is typeset
   * with once they are laid out. */
  private readonly cardFormulas = new Map<string, Set<string>>()
  /** The board's PDF cards (./pdfCards.ts): not typeset, their pages drawn
   * from their pictures far away. */
  private readonly pdfs = new Map<string, BoardNode>()
  private reading: Reading | null = null
  private readonly placed = new Map<string, Placed>()
  /** The scrollbar thumb of the card being read, over this canvas and
   * under the world layer, positioned in world units. */
  private readonly thumb: HTMLElement
  private thumbKey = ''

  constructor(private readonly deps: GpuBoardDeps) {
    const doc = deps.parent.ownerDocument
    this.canvas = doc.createElement('canvas')
    this.canvas.className = 'yolo-whiteboard-gpu-scene'
    deps.parent.appendChild(this.canvas)
    this.thumb = doc.createElement('div')
    this.thumb.className = 'yolo-whiteboard-gpu-thumb'
    this.thumb.hidden = true
    deps.parent.appendChild(this.thumb)
    this.scene = new GpuScene(this.canvas)
    const ctx = doc.createElement('canvas').getContext('2d', {
      willReadFrequently: true,
    })
    if (!ctx) throw new Error('no 2D canvas')
    this.colorCtx = ctx
  }

  /** The board's cards, bottom to top. */
  setNodes(nodes: readonly BoardNode[]): void {
    const seen = new Set<string>()
    const cards: string[] = []
    const pdfs = new Set<string>()
    for (const node of nodes) {
      if (isScenePdf(node)) {
        pdfs.add(node.id)
        cards.push(node.id)
        if (this.pdfs.get(node.id) !== node) this.pdfs.set(node.id, node)
        continue
      }
      if (!drawsContent(node)) continue
      seen.add(node.id)
      cards.push(node.id)
      const before = this.nodes.get(node.id)
      if (before === node) continue
      if (before && contentOf(before) !== contentOf(node)) {
        this.changed.add(node.id)
        this.drawableRevision += 1
      }
      this.nodes.set(node.id, node)
      this.pending.set(node.id, { node, text: null, reading: false })
    }
    for (const id of [...this.nodes.keys()]) {
      if (seen.has(id)) continue
      this.nodes.delete(id)
      this.pending.delete(id)
      this.scene.removeCard(id)
      this.setDrawable(id, false)
      this.changed.delete(id)
      this.texts.delete(id)
      this.placed.delete(id)
      if (this.reading?.id === id) this.reading = null
      this.cardImages.delete(id)
      this.scene.setImages(id, [])
      this.dropKept(id)
    }
    for (const id of [...this.pdfs.keys()]) {
      if (pdfs.has(id)) continue
      this.pdfs.delete(id)
      this.scene.removeCard(id)
      this.scene.setImages(id, [])
    }
    this.scene.setOrder(cards)
    this.dirty = true
  }

  /** A file changed: the note cards showing it are typeset again, and
   * built until they are. */
  fileChanged(path: string): void {
    this.deps.images.fileChanged(path)
    for (const node of this.nodes.values()) {
      const embeds = this.cardImages
        .get(node.id)
        ?.some((image) => image.path === path)
      if (!embeds && (node.type !== 'file' || node.file !== path)) continue
      this.pending.set(node.id, { node, text: null, reading: false })
      this.changed.add(node.id)
      this.drawableRevision += 1
    }
  }

  /** What is known of an image on the web changed (`key`, its address):
   * its size was learned, or its bytes came or went. The cards that embed
   * it are typeset again. */
  imageLearned(key: string): void {
    const ids = this.remoteWaits.get(key)
    if (!ids) return
    this.remoteWaits.delete(key)
    for (const id of ids) {
      const node = this.nodes.get(id)
      if (node) this.pending.set(id, { node, text: null, reading: false })
    }
  }

  /** Whether a card may be drawn rather than built near to: it is
   * typeset, and holds nothing only the host's renderer shows as it should
   * (../typesetting/typesetter.ts's `needsHost`). */
  /** Whether the scene draws a card itself, far away as near to, so that
   * it wants no picture: one not typeset yet will be, unless typesetting
   * finds it the host's. */
  drawsItself(id: string): boolean {
    return (
      this.deps.typesetter.usable &&
      this.scene.usable &&
      this.nodes.has(id) &&
      (!this.texts.has(id) || this.drawables.has(id))
    )
  }

  /**
   * Reads a card — the one selected — or none: its whole note is typeset,
   * and the wheel moves it under its frame (`scrollBy`) from where its
   * window shows it, as far as its note goes. The card it leaves is typeset
   * from its window again, and shows the same until that comes: what was
   * read is written to its node first (`readingPosition`).
   */
  setReading(id: string | null): void {
    if (this.reading?.id === id) return
    const was = this.reading
    this.reading = null
    if (was) {
      const node = this.nodes.get(was.id)
      if (node) this.pending.set(was.id, { node, text: null, reading: false })
    }
    const node = id === null ? undefined : this.nodes.get(id)
    this.dirty = true
    if (id === null || !node || isPlainText(node)) return
    const scroll = this.scene.cardOf(id)?.scroll ?? readingOffset(node)
    this.reading = {
      id,
      scroll,
      target: scroll,
      full: false,
      host: false,
      goto: null,
      lastTime: 0,
    }
    this.pending.set(id, { node, text: null, reading: false })
    this.wanted.add(id)
    this.moved(this.reading)
  }

  /**
   * Moves the card being read by a wheel's `deltaY`, in its own units, as
   * the DOM preview scrolls (../wheelScroll.ts): eased toward a target
   * clamped to how far its note goes. False when it is not the card being
   * read, or all of it shows: the wheel is the board's then.
   */
  scrollBy(id: string, deltaY: number): boolean {
    const reading = this.reading
    if (reading?.id !== id || reading.host) return false
    const max = this.maxScroll(id)
    if (max === null || max <= 0) return false
    reading.target = Math.max(0, Math.min(max, reading.target + deltaY))
    const win = this.canvas.ownerDocument.defaultView
    if (!win || win.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      reading.scroll = reading.target
      this.moved(reading)
    } else if (reading.lastTime === 0) {
      reading.lastTime = win.performance.now()
    }
    return true
  }

  /**
   * Turns the card being read to the block source line `line` is in, that
   * block's start at its top edge — at once if its whole note is placed,
   * once that comes otherwise. False when it is not the card being read
   * here: its window is the board's to move then.
   */
  readAt(id: string, line: number): boolean {
    const reading = this.reading
    if (reading?.id !== id || reading.host) return false
    const placed = this.placed.get(id)
    if (!reading.full || !placed) {
      reading.goto = line
      return true
    }
    reading.scroll = this.clampScroll(
      id,
      blockTop(placed.blocks, line) - (placed.blocks[1] ?? 0),
    )
    reading.target = reading.scroll
    reading.lastTime = 0
    this.moved(reading)
    return true
  }

  private clampScroll(id: string, scroll: number): number {
    return Math.max(0, Math.min(this.maxScroll(id) ?? 0, scroll))
  }

  /**
   * Where a card is read, as fileFormat.ts's reading window has it: the
   * line of the block its top edge is in, and how far down that block it
   * is. Null for a card with nothing placed.
   */
  readingPosition(
    id: string,
  ): Readonly<{ line: number; offset: number }> | null {
    const placed = this.placed.get(id)
    const card = this.scene.cardOf(id)
    if (!placed || !card || placed.blocks.length === 0) return null
    const scroll =
      this.reading?.id === id ? this.reading.scroll : (card.scroll ?? 0)
    const { blocks, from } = placed
    const top = blocks[1]
    let at = 0
    for (let i = 2; i < blocks.length; i += 2) {
      if (blocks[i + 1] - top > scroll) break
      at = i
    }
    return { line: from + blocks[at], offset: scroll - (blocks[at + 1] - top) }
  }

  /** How far a card's content can be moved up: until its end, and the
   * bottom inset under it, meet its bottom edge. Null before it is placed. */
  private maxScroll(id: string): number | null {
    const placed = this.placed.get(id)
    const node = this.nodes.get(id)
    const tokens = this.deps.style.tokens
    if (!placed || !node || !tokens) return null
    return placed.end + tokens.inset.bottom - node.h
  }

  /** The card being read is where it is moved to: its row in the card
   * table, and what is placed in it. */
  private moved(reading: Reading): void {
    const card = this.scene.cardOf(reading.id)
    const node = this.nodes.get(reading.id)
    const tokens = this.deps.style.tokens
    if (!card || !node || !tokens) return
    this.scene.setCard(reading.id, {
      ...card,
      fade: 0,
      scroll: reading.scroll,
      clipTop: tokens.inset.top,
    })
    const text = this.texts.get(reading.id)
    if (text) {
      this.texts.set(reading.id, {
        ...text,
        view: { scroll: reading.scroll, top: tokens.inset.top, bottom: node.h },
      })
    }
    this.dirty = true
    this.deps.onScroll(reading.id)
  }

  /** A step of the wheel's glide (`scrollBy`), at `now`. */
  private glide(now: number): void {
    const reading = this.reading
    if (!reading || reading.lastTime === 0) return
    const dt = Math.max(0, now - reading.lastTime)
    reading.lastTime = now
    const k = 1 - Math.exp(-dt / WHEEL_PAN_GLIDE_TAU_MS)
    reading.scroll += (reading.target - reading.scroll) * k
    if (Math.abs(reading.target - reading.scroll) < 0.5) {
      reading.scroll = reading.target
      reading.lastTime = 0
    }
    this.moved(reading)
  }

  /** The thumb of the card being read, where its card is on screen, and
   * none while all of it shows. Written only when it changes. */
  private syncThumb(view: CanvasView): void {
    const reading = this.reading
    const node = reading ? this.nodes.get(reading.id) : undefined
    const max = reading ? this.maxScroll(reading.id) : null
    if (
      !reading ||
      !node ||
      max === null ||
      max <= 0 ||
      !this.shown.has(node.id)
    ) {
      if (this.thumbKey !== '') {
        this.thumbKey = ''
        this.thumb.hidden = true
      }
      return
    }
    const track = node.h - 2 * THUMB_INSET
    const length = Math.max(THUMB_MIN, (track * node.h) / (node.h + max))
    const top = node.y + THUMB_INSET + (reading.scroll / max) * (track - length)
    const left = node.x + node.w - THUMB_GUTTER + THUMB_INSET
    const width = THUMB_GUTTER - 2 * THUMB_INSET
    const key = `${left},${top},${length},${view.scale},${view.tx},${view.ty}`
    if (key === this.thumbKey) return
    this.thumbKey = key
    this.thumb.hidden = false
    this.thumb.style.width = `${width}px`
    this.thumb.style.height = `${length}px`
    this.thumb.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.scale}) translate(${left}px, ${top}px)`
  }

  drawable(id: string): boolean {
    return (
      this.drawables.has(id) &&
      !(this.reading?.id === id && this.reading.host) &&
      this.deps.typesetter.usable &&
      this.scene.usable &&
      !this.changed.has(id)
    )
  }

  /** The text a typeset card draws and where, for placing a passage in
   * it while it is drawn (./passages.ts); null before it is typeset. */
  drawnText(id: string): DrawnText | null {
    return this.texts.get(id) ?? null
  }

  /** The images the cards drawn now embed, each as wide as it is shown at
   * its widest, for their pictures to be made (../pictures/imageFiles.ts). */
  *shownImages(): Iterable<
    Readonly<{ id: string; path: string; width: number }>
  > {
    for (const id of this.shown) {
      for (const image of this.cardImages.get(id) ?? []) {
        yield { id, path: image.path, width: image.w }
      }
    }
  }

  /** Changes whenever `drawable` may answer differently. */
  get revision(): number {
    return this.drawableRevision
  }

  begin(): void {
    this.claimed = new Map()
    this.claimsChanged = true
    this.dirty = true
  }

  claim(node: BoardNode, rect: CardRect): boolean {
    const tokens = this.deps.style.tokens
    // Without a worker nothing is claimed: the overview draws pictures as
    // it would without this layer.
    if (!tokens || !this.deps.typesetter.usable || !this.scene.usable) {
      return false
    }
    if (this.pdfs.has(node.id)) return this.claimPdf(node, rect)
    if (!this.nodes.has(node.id)) return false
    if (this.pending.has(node.id)) this.wanted.add(node.id)
    // One typeset again shows what it has until that comes — its window
    // while its whole note does, the old look while the new one does — unless
    // what it holds changed: that is out of date.
    if (!this.scene.cardOf(node.id) || this.changed.has(node.id)) {
      this.wanted.add(node.id)
      return false
    }
    this.claimed.set(node.id, rect)
    return true
  }

  /** A PDF card, drawn here once the picture of the first page it shows is
   * there and it is wide enough on screen to show one — as the overview
   * would draw it with its pictures; until then the overview draws it. */
  private claimPdf(node: BoardNode, rect: CardRect): boolean {
    const start = firstPage(node)
    if (!start || !this.deps.pagePicture(start.file, start.page)) return false
    if (rect.w * this.deps.view().scale < PICTURE_MIN_SCREEN_PX) return false
    if (!this.scene.cardOf(node.id)) {
      this.scene.setCard(node.id, {
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
        frame: this.frameOf(node, this.deps.isSelected(node.id)),
        fade: 0,
        clip: { left: 0, right: 0 },
        content: null,
      })
      this.scene.setShown(node.id, false)
    }
    this.claimed.set(node.id, rect)
    return true
  }

  /** Called every frame, after the overview's: typesets what is owed, and
   * draws when anything changed. */
  render(now: number): void {
    const tokens = this.deps.style.tokens
    const hash = this.deps.style.hash
    if (tokens && hash !== null) {
      if (hash !== this.styleHash) this.newLook(hash)
      this.typeset({ tokens, hash })
    }
    if (this.claimsChanged) {
      this.claimsChanged = false
      this.syncShown()
    }
    this.glide(now)
    const view = this.deps.view()
    this.syncThumb(view)
    const last = this.lastView
    if (
      !last ||
      last.tx !== view.tx ||
      last.ty !== view.ty ||
      last.scale !== view.scale
    ) {
      this.lastView = view
      this.movedAt = now
      this.dirty = true
    }
    const settled = now - this.movedAt >= SETTLE_MS
    // The frame the camera comes to rest on is drawn once more, sharp.
    if (settled && this.movedAt > 0) {
      this.movedAt = -1
      this.dirty = true
    }
    if (!this.dirty) return
    const dpr = this.canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1
    const body = tokens?.body.size ?? 16
    const result = this.scene.render(
      view,
      settled || this.movedAt === -1,
      this.deps.imagePicture,
      body * view.scale * dpr < MIN_BODY_DEVICE_PX,
      MIN_BODY_DEVICE_PX / body,
    )
    this.dirty = result.more
  }

  /** Shows what the overview claimed, where it claimed it — a card a
   * gesture is moving at its live rectangle — and nothing else. */
  private syncShown(): void {
    const view = this.deps.view()
    const width = this.canvas.clientWidth
    const height = this.canvas.clientHeight
    for (const id of this.claimed.keys()) {
      if (this.deps.isMounted(id)) this.claimed.delete(id)
    }
    for (const id of this.shown) {
      if (this.claimed.has(id)) continue
      // One gone off screen is out of sight anyway: left as it is, so that
      // panning changes nothing in the card table.
      const card = this.scene.cardOf(id)
      if (card && !onScreen(card, view, width, height)) continue
      this.scene.setShown(id, false)
      this.shown.delete(id)
      this.dirty = true
    }
    for (const [id, rect] of this.claimed) {
      const card = this.scene.cardOf(id)
      const pdf = this.pdfs.get(id)
      const node = this.nodes.get(id) ?? pdf
      if (!card || !node) continue
      // A PDF's pages, where they are at its rectangle now — and as far as
      // their pictures have come.
      if (pdf) {
        const start = firstPage(pdf)
        this.scene.setImages(
          id,
          start
            ? pdfCardImages(pdf, rect.w, rect.h, (page) =>
                this.deps.pagePicture(start.file, page),
              )
            : [],
        )
        this.dirty = true
      }
      const frame = this.frameOf(node, this.deps.isSelected(id))
      if (
        card.x !== rect.x ||
        card.y !== rect.y ||
        card.w !== rect.w ||
        card.h !== rect.h ||
        !sameFrame(card.frame, frame)
      ) {
        this.scene.setCard(id, {
          ...card,
          x: rect.x,
          y: rect.y,
          w: rect.w,
          h: rect.h,
          frame,
        })
        this.dirty = true
      }
      if (this.shown.has(id)) continue
      this.scene.setShown(id, true)
      this.shown.add(id)
      this.dirty = true
    }
  }

  destroy(): void {
    // Not written now: a board closes as the module goes too, when nothing
    // can be written. What came in the last moments is typeset again.
    if (this.keepTimer !== null) clearTimeout(this.keepTimer)
    this.keepTimer = null
    this.scene.dispose()
    this.canvas.remove()
    this.thumb.remove()
  }

  /** The look changed — or is read for the first time: every card is
   * typeset again. What is drawn stays until its replacement comes. */
  private newLook(hash: string): void {
    this.styleHash = hash
    this.palette = null
    // Card frames are in the palette's colours.
    this.claimsChanged = true
    this.generation += 1
    for (const node of this.nodes.values()) {
      this.pending.set(node.id, { node, text: null, reading: false })
    }
  }

  /** Hands the worker the next cards owed — those the overview asked for
   * first, then the rest in board order — once their text is there; a card
   * kept on this device as it would be typeset is placed from there instead
   * (`placeKept`). */
  private typeset(look: Look): void {
    if (!this.deps.typesetter.usable || this.pending.size === 0) return
    if (!this.keptReady()) return
    this.placeKept(look)
    while (this.inFlight < IN_FLIGHT) {
      const order = [
        ...[...this.wanted].filter((id) => this.pending.has(id)),
        ...this.pending.keys(),
      ]
      const batch: Sent[] = []
      for (const id of order) {
        if (batch.length >= BATCH) break
        const pending = this.pending.get(id)
        if (!pending) continue
        const ready = this.prepared(id, pending)
        if (!ready) continue
        this.pending.delete(id)
        batch.push({ pending, ...ready })
      }
      if (batch.length === 0) return
      this.wanted.clear()
      this.inFlight += 1
      const generation = this.generation
      this.deps.typesetter
        .typeset(
          look,
          batch.map((b) => b.card),
        )
        .then(
          (result) => {
            if (generation !== this.generation) return
            // Kept before it is placed: placing turns its glyphs' keys into
            // the atlas's ids, which mean nothing in another session.
            this.keepTypeset(batch, result)
            this.place(look, batch, result)
          },
          (error: unknown) => this.deps.reportError('typeset', error),
        )
        .finally(() => {
          this.inFlight -= 1
          this.dirty = true
        })
    }
  }

  /**
   * What a card owed is typeset from, once it is all there: a note's text
   * read, and the sizes of the images it embeds — null meanwhile, the read
   * asked for. Its stamp (../typesetting/typesetCache.ts) is worked out the
   * first time, for the cards kept on this device.
   */
  private prepared(
    id: string,
    pending: Pending,
  ): Readonly<{ card: TypesetCard; paths: Record<string, string> }> | null {
    if (pending.reading) return null
    const { node } = pending
    if (node.type === 'file' && pending.text === null) {
      this.read(id, pending)
      return null
    }
    // The card being read is typeset whole; any other from its window.
    const full = this.reading?.id === id
    const text = node.type === 'text' ? node.text : (pending.text ?? '')
    const markdown = full ? text : clippedCardMarkdown(node, text)
    // The images it embeds are laid out by their own sizes: it waits for
    // those to be read.
    const images: Record<string, Readonly<{ w: number; h: number }>> = {}
    const paths: Record<string, string> = {}
    let waiting = false
    for (const target of imageTargets(markdown)) {
      const path = this.deps.images.resolve(target)
      if (path === null) continue
      const size = this.deps.images.get(path)
      // One on the web is typeset again when it is shown or its bytes come
      // or go; until they are kept the card is the DOM's.
      if (isRemoteImage(path)) {
        const ids = this.remoteWaits.get(path) ?? new Set<string>()
        ids.add(id)
        this.remoteWaits.set(path, ids)
      }
      if (size === undefined) waiting = true
      else if (size !== null && this.deps.images.drawable(path)) {
        images[target] = size
        paths[target] = path
      }
    }
    if (waiting) return null
    const plain = isPlainText(node)
    const offset = full ? 0 : readingOffset(node)
    const math: Record<string, MathLayout | null> = {}
    for (const key of this.cardFormulas.get(id) ?? []) {
      const layout = this.formulas.get(key)
      if (layout !== undefined && layout !== 'asked') math[key] = layout
    }
    return {
      paths,
      card: {
        id,
        markdown,
        images,
        math,
        w: node.w,
        h: node.h,
        // Moved up by its window's offset, it shows that much further down;
        // the card being read, as far as its note goes.
        ...(full
          ? { reach: Infinity }
          : offset > 0
            ? { reach: node.h + offset }
            : {}),
        plain,
        color:
          plain && node.color !== undefined ? this.nodeColor(node.color) : null,
      },
    }
  }

  /** Whether what this device keeps of the board's cards is known — read
   * the first time here, in one go. A board with no store, or no path yet,
   * keeps nothing. */
  private keptReady(): boolean {
    const cache = this.deps.cache
    const group = cache?.group() ?? ''
    if (!cache || group === '') return true
    if (this.keptGroup === group) return true
    if (this.keptLoading) return false
    this.keptLoading = true
    const settle = (kept: Map<string, KeptBytes>) => {
      this.kept = kept
      this.keptGroup = group
      this.keptLoading = false
      this.dirty = true
      // What it keeps of cards the board no longer has goes.
      for (const id of [...kept.keys()]) {
        if (!this.nodes.has(id)) this.dropKept(id)
      }
    }
    const readPacks = async () => {
      const kept = new Map<string, KeptBytes>()
      for (let i = 0; ; i++) {
        const data = await cache.store.read(
          group,
          TYPESET_GROUP_VERSION,
          packKey(i),
        )
        if (!data) return kept
        for (const [id, card] of decodePack(data)) kept.set(id, card)
      }
    }
    readPacks().then(settle, (error: unknown) => {
      this.deps.reportError('kept typesets', error)
      settle(new Map())
    })
    return false
  }

  /** Places every card owed whose input is the one it was kept from, as one
   * batch; one kept wrong goes to the worker. */
  private placeKept(look: Look): void {
    if (this.keptGroup === null) return
    const cards: TypesetResultCard[] = []
    const keys: string[] = []
    const placed: Sent[] = []
    for (const [id, pending] of this.pending) {
      // A whole note is typeset afresh: it is not kept.
      if (pending.stamp !== undefined || this.reading?.id === id) continue
      const ready = this.prepared(id, pending)
      if (!ready) continue
      pending.stamp = typesetStamp(look.hash, ready.card, ready.paths)
      const bytes = this.kept.get(id)
      if (bytes?.stamp !== pending.stamp) continue
      const entry = decodeTypeset(id, bytes.data)
      if (!entry) {
        this.dropKept(id)
        continue
      }
      this.pending.delete(id)
      // Its own keys, after the batch's so far.
      const glyphs = new Uint32Array(entry.card.glyphs)
      for (let g = 3; g < glyphs.length; g += GLYPH_WORDS) {
        glyphs[g] += keys.length
      }
      keys.push(...entry.keys)
      cards.push(entry.card)
      placed.push({ pending, ...ready })
    }
    if (cards.length > 0) this.place(look, placed, { cards, keys })
  }

  /** Keeps on this device the cards the worker typeset, each under the
   * stamp of what it was typeset from — those still as they were sent. */
  private keepTypeset(batch: readonly Sent[], result: TypesetResult): void {
    if (this.keptGroup === null) return
    const sent = new Map(batch.map((b) => [b.card.id, b]))
    for (const card of result.cards) {
      const entry = sent.get(card.id)
      const stamp = entry?.pending.stamp
      if (!entry || stamp === undefined) continue
      if (this.nodes.get(card.id) !== entry.pending.node) continue
      // One still owed its formulas is typeset again once it has them.
      if (card.math) continue
      this.kept.set(card.id, { stamp, data: encodeTypeset(card, result.keys) })
      this.keptChanged()
    }
  }

  private dropKept(id: string): void {
    if (this.kept.delete(id)) this.keptChanged()
  }

  /** What is kept changed: written back a while after it last does. */
  private keptChanged(): void {
    if (this.keepTimer !== null) clearTimeout(this.keepTimer)
    this.keepTimer = setTimeout(() => this.writeKept(), KEEP_DELAY_MS)
  }

  private writeKept(): void {
    if (this.keepTimer !== null) clearTimeout(this.keepTimer)
    this.keepTimer = null
    const cache = this.deps.cache
    const group = this.keptGroup
    if (!cache || group === null) return
    const keys = new Set<string>()
    encodePacks(this.kept).forEach((data, i) => {
      keys.add(packKey(i))
      cache.store.write(group, TYPESET_GROUP_VERSION, packKey(i), data, {
        width: 0,
        height: 0,
        stamp: '',
        meta: null,
      })
    })
    // The entries past the last now written hold nothing current.
    cache.store.keep(group, TYPESET_GROUP_VERSION, keys)
  }

  private setDrawable(id: string, drawable: boolean): void {
    if (this.drawables.has(id) === drawable) return
    if (drawable) this.drawables.add(id)
    else this.drawables.delete(id)
    this.drawableRevision += 1
  }

  /** Reads a note's text, for a later batch. */
  private read(id: string, pending: Pending): void {
    pending.reading = true
    if (pending.node.type !== 'file') return
    void this.deps.readNote(pending.node.file).then((text) => {
      pending.reading = false
      pending.text = text ?? ''
      // Still owed as it was asked for: otherwise asked for anew.
      if (this.pending.get(id) === pending) this.dirty = true
    })
  }

  /** What the worker typeset, into the scene — the atlas's ids for its
   * glyph keys — for each card still as it was when it was sent. */
  private place(
    look: Look,
    batch: readonly Sent[],
    result: TypesetResult,
  ): void {
    const atlas = this.scene.glyphs
    const ids = result.keys.map((key) => {
      const parsed = parseKey(key)
      return parsed.kind === 'icon'
        ? atlas.iconId(parsed.name, parsed.size)
        : parsed.kind === 'path'
          ? atlas.pathId(parsed.path, parsed.transform)
          : atlas.glyphId(parsed.text, parsed.font)
    })
    const sent = new Map(batch.map((b) => [b.card.id, b]))
    const placed: string[] = []
    for (const typeset of result.cards) {
      const entry = sent.get(typeset.id)
      if (!entry || this.nodes.get(typeset.id) !== entry.pending.node) continue
      // A whole note for a card no longer read, or a window for one whose
      // whole note is placed, is out of date.
      const full = entry.card.reach === Infinity
      const reading = this.reading?.id === typeset.id ? this.reading : null
      if (full ? !reading : reading?.full) continue
      // A whole note still owed formulas past its window waits for them
      // (`layoutFormulas`): placed now, it would be the host's until they
      // come, and the card read would be built for that long and then drawn
      // again. Its window shows meanwhile.
      if (full && typeset.math) continue
      // One whose whole note the host has to render is read in its DOM
      // preview: it is left as it was here, its window, until it is read no
      // more and typeset from its window again (`setReading`).
      if (reading && full && typeset.host) {
        reading.host = true
        this.drawableRevision += 1
        continue
      }
      const glyphs = new Uint32Array(typeset.glyphs)
      const used = new Set<number>()
      for (let i = 3; i < glyphs.length; i += GLYPH_WORDS) {
        glyphs[i] = ids[glyphs[i]]
        used.add(glyphs[i])
      }
      const { node } = entry.pending
      this.setDrawable(node.id, !typeset.host)
      if (reading && full) this.readWhole(reading, node, typeset)
      this.placed.set(node.id, {
        from: full ? 0 : windowLine(node),
        blocks: typeset.blocks,
        end: typeset.end,
      })
      const scroll = reading
        ? { scroll: reading.scroll, clipTop: look.tokens.inset.top }
        : scrollOf(node, look.tokens)
      this.texts.set(node.id, {
        shown: typeset.shown,
        runs: new Float32Array(typeset.runs),
        fonts: typeset.fonts,
        ...(scroll.scroll > 0
          ? {
              view: {
                scroll: scroll.scroll,
                top: scroll.clipTop,
                bottom: node.h,
              },
            }
          : {}),
      })
      const images: CardImage[] = []
      for (const image of typeset.images) {
        const path = entry.paths[image.target]
        if (path !== undefined) images.push({ ...image, path })
      }
      this.cardImages.set(node.id, images)
      this.scene.setImages(node.id, images)
      placed.push(node.id)
      if (this.changed.delete(node.id)) this.drawableRevision += 1
      // Not shown until the overview claims it: it draws the surface.
      const before = this.scene.cardOf(node.id)
      this.scene.setCard(node.id, {
        x: node.x,
        y: node.y,
        w: node.w,
        h: node.h,
        frame: before?.frame ?? null,
        fade: entry.card.plain || reading ? 0 : FADE,
        clip: contentClip(look.tokens, entry.card.plain),
        ...scroll,
        content: {
          rects: new Uint32Array(typeset.rects),
          glyphs,
          greeks: new Uint32Array(typeset.greeks),
          glyphIds: [...used],
        },
      })
      if (!before) this.scene.setShown(node.id, false)
    }
    // The overview draws their pictures until it asks again.
    this.deps.redrawOverview()
    if (placed.length > 0) this.deps.onTypeset(placed)
    this.layoutFormulas(batch, result)
  }

  /**
   * The whole note of the card being read came: where it is moved to in it
   * is where it was in what it had — its window, its block moved down by
   * as far as that block is into the note — so what shows does not change.
   * Clamped to where the note ends.
   */
  private readWhole(
    reading: Reading,
    node: BoardNode,
    typeset: TypesetResultCard,
  ): void {
    const was = this.placed.get(node.id)
    const shift = was
      ? blockTop(typeset.blocks, was.from + (was.blocks[0] ?? 0)) -
        (was.blocks[1] ?? 0)
      : 0
    reading.full = true
    const max = Math.max(
      0,
      typeset.end + (this.deps.style.tokens?.inset.bottom ?? 0) - node.h,
    )
    // Turned somewhere while it came (`readAt`): there, rather than where
    // it was.
    const goto = reading.goto
    reading.goto = null
    const scroll =
      goto === null
        ? reading.scroll + shift
        : blockTop(typeset.blocks, goto) - (typeset.blocks[1] ?? 0)
    reading.scroll = Math.min(max, Math.max(0, scroll))
    reading.target =
      goto === null
        ? Math.min(max, Math.max(0, reading.target + shift))
        : reading.scroll
  }

  /**
   * Asks the host to lay out the formulas the worker found in cards and was
   * not given, and typesets those cards again once they are back: until
   * then each is the DOM's (its `host`). A formula is asked for once a
   * board; one the host could not lay out keeps its cards the DOM's.
   */
  private layoutFormulas(batch: readonly Sent[], result: TypesetResult): void {
    const sent = new Map(batch.map((b) => [b.card.id, b]))
    const asking = new Map<string, MathSource>()
    for (const typeset of result.cards) {
      const entry = sent.get(typeset.id)
      if (!typeset.math || !entry) continue
      const keys = this.cardFormulas.get(typeset.id) ?? new Set<string>()
      for (const formula of typeset.math) {
        const key = mathKey(formula)
        keys.add(key)
        if (!this.formulas.has(key)) asking.set(key, formula)
      }
      this.cardFormulas.set(typeset.id, keys)
    }
    if (asking.size === 0) return
    for (const key of asking.keys()) this.formulas.set(key, 'asked')
    const generation = this.generation
    const keys = [...asking.keys()]
    const settle = (layouts: readonly (MathLayout | null)[]) => {
      keys.forEach((key, i) => this.formulas.set(key, layouts[i] ?? null))
      // Its cards, typeset again with them — any still as they were.
      for (const [id, wanted] of this.cardFormulas) {
        const node = this.nodes.get(id)
        if (!node) {
          this.cardFormulas.delete(id)
          continue
        }
        if (!keys.some((key) => wanted.has(key))) continue
        if (generation !== this.generation || this.pending.has(id)) continue
        const was = sent.get(id)?.pending
        this.pending.set(id, {
          node,
          text: was?.node === node ? was.text : null,
          reading: false,
        })
      }
      this.dirty = true
    }
    this.deps
      .layoutMath([...asking.values()])
      .then(settle, (error: unknown) => {
        this.deps.reportError('math', error)
        settle([])
      })
  }

  /**
   * A card's frame as the overview draws it (../canvas/overviewLayer.ts's
   * `drawCards`): its surface, washed with its colour when it has one; its
   * border in the theme's border colour, or its own colour faintly; the
   * accent, wider, when it is selected. Bare text has only the selection.
   */
  private frameOf(node: BoardNode, selected: boolean): SceneFrame | null {
    const palette = (this.palette ??= this.readPalette())
    const tint = node.color !== undefined ? this.nodeColor(node.color) : null
    const tintWord = tint === null ? null : this.pack(tint)
    if (isPlainText(node)) {
      return selected
        ? {
            fill: 0,
            border: palette.accent,
            borderWidth: SELECTED_BORDER,
            radius: 0,
          }
        : null
    }
    return {
      fill:
        tintWord === null
          ? palette.background
          : mix(palette.background, tintWord, palette.wash),
      border: selected
        ? palette.accent
        : tintWord === null
          ? palette.border
          : withAlpha(tintWord, OVERVIEW_THEMED_BORDER_ALPHA),
      borderWidth: selected ? SELECTED_BORDER : CARD_BORDER,
      radius: CARD_RADIUS,
    }
  }

  private readPalette(): Palette {
    const style = this.canvas.ownerDocument.defaultView?.getComputedStyle(
      this.deps.root,
    )
    const read = (name: string, fallback: string) =>
      style?.getPropertyValue(name).trim() || fallback
    const dark = this.deps.root.closest('.theme-dark') !== null
    return {
      background: this.pack(
        read('--yolo-whiteboard-card-background', '#ffffff'),
      ),
      border: this.pack(read('--yolo-whiteboard-card-border', '#e8e8e8')),
      accent: this.pack(read('--interactive-accent', '#7c3aed')),
      wash: dark
        ? OVERVIEW_THEMED_CARD_WASH_ALPHA.dark
        : OVERVIEW_THEMED_CARD_WASH_ALPHA.light,
    }
  }

  /** A CSS colour as RGBA8, as the canvas parses it. */
  private pack(css: string): number {
    const ctx = this.colorCtx
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = '#000'
    ctx.fillStyle = css
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
    return packColor(r, g, b, a)
  }

  private nodeColor(color: string): string | null {
    const resolved = resolveColor(color)
    if (resolved.kind === 'none') return null
    if (resolved.kind === 'custom') return resolved.hex
    const value = this.canvas.ownerDocument.defaultView
      ?.getComputedStyle(this.deps.root)
      .getPropertyValue(`--yolo-whiteboard-color-${resolved.preset}`)
      .trim()
    return value ? value : null
  }
}

/** Whether a node is a card the typesetter lays out: text, or a note. */
function drawsContent(node: BoardNode): boolean {
  if (node.type === 'text') return true
  return node.type === 'file' && fileNodeKind(node.file) === 'markdown'
}

function onScreen(
  card: Readonly<{ x: number; y: number; w: number; h: number }>,
  view: CanvasView,
  width: number,
  height: number,
): boolean {
  const x = card.x * view.scale + view.tx
  const y = card.y * view.scale + view.ty
  return (
    x < width &&
    y < height &&
    x + card.w * view.scale > 0 &&
    y + card.h * view.scale > 0
  )
}

/** How far a card's content is moved up (its window's offset,
 * ../canvas/cardContent.ts's `readingOffset`), and the line above which
 * what is moved up is cut off: the inner edge of the card's top inset, so
 * the inset stays clear. */
function scrollOf(
  node: BoardNode,
  tokens: TypesetTokens,
): Readonly<{ scroll: number; clipTop: number }> {
  const scroll = readingOffset(node)
  return { scroll, clipTop: scroll > 0 ? tokens.inset.top : 0 }
}

/** The line a card's window starts at (fileFormat.ts's `startLine`). */
function windowLine(node: BoardNode): number {
  if (isPlainText(node)) return 0
  return node.type === 'text' || node.type === 'file'
    ? (node.startLine ?? 0)
    : 0
}

/** Where the block at `line` starts in `blocks` (../../typeset/layout.ts's
 * `blocks`) — or, when no block starts there, the last one before it. */
function blockTop(blocks: readonly number[], line: number): number {
  let top = blocks[1] ?? 0
  for (let i = 0; i < blocks.length; i += 2) {
    if (blocks[i] > line) break
    top = blocks[i + 1]
  }
  return top
}

/** What of a card its typeset content is made from: a move keeps it; an
 * edit, a resize or a new colour do not. A note's text is its file's
 * (`fileChanged`). */
function contentOf(node: BoardNode): string {
  // The size wraps its lines, and bare text is set in its colour.
  const box = `${node.w}x${node.h}:${node.color ?? ''}`
  if (node.type === 'text') return `${box}:text:${node.text}`
  if (node.type === 'file') return `${box}:file:${node.file}`
  return `${box}:${node.type}`
}

/** The board's colours a card's frame is drawn in, as RGBA8 words. */
type Palette = Readonly<{
  background: number
  border: number
  accent: number
  /** How strongly a coloured card's surface takes its colour. */
  wash: number
}>

function sameFrame(a: SceneFrame | null, b: SceneFrame | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.fill === b.fill &&
    a.border === b.border &&
    a.borderWidth === b.borderWidth &&
    a.radius === b.radius
  )
}

/** `over` laid over `under` at `alpha`, both RGBA8 words. */
function mix(under: number, over: number, alpha: number): number {
  const channel = (shift: number) => {
    const a = (under >>> shift) & 255
    const b = (over >>> shift) & 255
    return Math.round(a + (b - a) * alpha)
  }
  return packColor(channel(0), channel(8), channel(16), (under >>> 24) & 255)
}

/** An RGBA8 word at `alpha` of its own opacity. */
function withAlpha(word: number, alpha: number): number {
  const a = Math.round(((word >>> 24) & 255) * alpha)
  return ((word & 0xffffff) | (a << 24)) >>> 0
}
