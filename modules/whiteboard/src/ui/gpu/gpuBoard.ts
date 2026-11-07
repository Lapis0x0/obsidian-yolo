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
// Behind a development switch while the scene grows into the board's
// renderer (docs/plans/…-whiteboard-gpu-renderer/p4-gpu.md): set
// `localStorage['yolo-whiteboard-gpu'] = '1'` and reopen a board.

import { resolveColor } from '../../domain/color'
import { type BoardNode, isPlainText } from '../../domain/fileFormat'
import { fileNodeKind } from '../../domain/naming'
import type { CardRect } from '../../domain/resize'
import type { CanvasView } from '../../domain/virtualization'
import type { TypesetTokens } from '../../typeset/tokens'
import { clippedCardMarkdown } from '../canvas/cardContent'
import type { ContentLayer } from '../canvas/overviewLayer'
import type { TypesetStyle } from '../pictures/typesetStyle'

import { familiesOf, fontSources } from './fontSources'
import { GLYPH_WORDS } from './instances'
import { GpuScene } from './scene'
import {
  type FontsPayload,
  TYPESET_WORKER,
  type TypesetCard,
  type TypesetPayload,
  type TypesetResult,
  parseKey,
} from './typesetProtocol'

export const GPU_SWITCH_KEY = 'yolo-whiteboard-gpu'

/** Whether the development switch is on in this window. */
export function gpuSwitchedOn(win: Window): boolean {
  try {
    return win.localStorage.getItem(GPU_SWITCH_KEY) === '1'
  } catch {
    return false
  }
}

const WORKER_SOURCE = Symbol.for(
  `yolo.module.inline-worker.v1:whiteboard:${TYPESET_WORKER}`,
)

/** The typesetting worker's source, which the module's build puts on the
 * global object (scripts/build-first-party-modules.mjs). */
export function typesetWorkerSource(): string {
  const source = (globalThis as Record<symbol, unknown>)[WORKER_SOURCE]
  if (typeof source !== 'string' || source.length === 0) {
    throw new Error('the typesetting worker is not in this build')
  }
  return source
}

/** How far above a framed card's bottom edge its content fades out
 * (styles/cards/content.css's mask). */
const FADE = 24
/** How long the camera must have been still to count as at rest, ms. */
const SETTLE_MS = 120
/** The smallest a card's body type is drawn, in device pixels: below it a
 * card's picture says as much, for far less. */
const MIN_BODY_DEVICE_PX = 5
/** Cards a call to the worker typesets, and calls in flight at once: few
 * enough that what the overview asks for next is not queued behind the
 * whole board. */
const BATCH = 32
const IN_FLIGHT = 2

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
  /** Has the overview draw again: it asks anew which cards this layer
   * draws. */
  redrawOverview: () => void
  readNote: (path: string) => Promise<string | null>
  /** The typesetting worker (./typesetWorker.ts), started. */
  startWorker: () => YoloModuleHostWorkerV1
  reportError: (stage: string, error: unknown) => void
}>

/** A card owed its content: a note's text is read first. */
type Pending = { node: BoardNode; text: string | null; reading: boolean }

export class GpuBoard implements ContentLayer {
  readonly canvas: HTMLCanvasElement
  private readonly scene: GpuScene
  private readonly nodes = new Map<string, BoardNode>()
  /** Cards whose content is owed, in the order they are typeset. */
  private readonly pending = new Map<string, Pending>()
  /** Null when it could not be started: then nothing is claimed, and the
   * overview draws pictures as it would without this layer. */
  private readonly worker: YoloModuleHostWorkerV1 | null
  private inFlight = 0
  /** Counts the looks typeset in: a result for an older one is dropped. */
  private generation = 0
  private lastView: CanvasView | null = null
  private movedAt = 0
  private dirty = true
  private styleHash: string | null = null
  /** What the overview's last frame had this layer draw, and where. */
  private claimed = new Map<string, CardRect>()
  /** What the scene shows now. */
  private shown = new Set<string>()
  /** Cards asked for that are not typeset yet: typeset first. */
  private readonly wanted = new Set<string>()

  constructor(private readonly deps: GpuBoardDeps) {
    const doc = deps.parent.ownerDocument
    this.canvas = doc.createElement('canvas')
    this.canvas.className = 'yolo-whiteboard-gpu-scene'
    deps.parent.appendChild(this.canvas)
    // DEBUG(p4): reachable from the console while the scene is developed.
    Object.assign(this.canvas, { gpuBoard: this })
    this.scene = new GpuScene(this.canvas)
    let worker: YoloModuleHostWorkerV1 | null = null
    try {
      worker = deps.startWorker()
    } catch (error) {
      deps.reportError('typeset worker', error)
    }
    this.worker = worker
  }

  /** The board's cards, bottom to top. */
  setNodes(nodes: readonly BoardNode[]): void {
    const seen = new Set<string>()
    const cards: string[] = []
    for (const node of nodes) {
      if (!drawsContent(node)) continue
      seen.add(node.id)
      cards.push(node.id)
      const before = this.nodes.get(node.id)
      if (before === node) continue
      this.nodes.set(node.id, node)
      this.pending.set(node.id, { node, text: null, reading: false })
    }
    for (const id of [...this.nodes.keys()]) {
      if (seen.has(id)) continue
      this.nodes.delete(id)
      this.pending.delete(id)
      this.scene.removeCard(id)
    }
    this.scene.setOrder(cards)
    this.dirty = true
  }

  begin(): void {
    this.claimed = new Map()
    this.dirty = true
  }

  claim(node: BoardNode, rect: CardRect, scale: number): boolean {
    const tokens = this.deps.style.tokens
    if (!tokens || !this.worker || !this.scene.usable) return false
    const dpr = this.canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1
    if (tokens.body.size * scale * dpr < MIN_BODY_DEVICE_PX) return false
    if (!this.nodes.has(node.id)) return false
    if (this.pending.has(node.id) || !this.scene.cardOf(node.id)) {
      this.wanted.add(node.id)
      return false
    }
    this.claimed.set(node.id, rect)
    return true
  }

  /** Called every frame, after the overview's: typesets what is owed, and
   * draws when anything changed. */
  render(now: number): void {
    const tokens = this.deps.style.tokens
    const hash = this.deps.style.hash
    if (tokens && hash !== this.styleHash) this.newLook(tokens, hash)
    if (tokens) this.typeset(tokens)
    this.syncShown()
    const view = this.deps.view()
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
    const result = this.scene.render(view, settled || this.movedAt === -1)
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
      if (!card) continue
      if (
        card.x !== rect.x ||
        card.y !== rect.y ||
        card.w !== rect.w ||
        card.h !== rect.h
      ) {
        this.scene.setCard(id, {
          ...card,
          x: rect.x,
          y: rect.y,
          w: rect.w,
          h: rect.h,
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
    this.worker?.terminate()
    this.scene.dispose()
    this.canvas.remove()
  }

  /** The look changed — or is read for the first time: its fonts go to the
   * worker, and every card is typeset again. What is drawn stays until its
   * replacement comes. */
  private newLook(tokens: TypesetTokens, hash: string | null): void {
    this.styleHash = hash
    this.generation += 1
    for (const node of this.nodes.values()) {
      this.pending.set(node.id, { node, text: null, reading: false })
    }
    const faces = fontSources(this.canvas.ownerDocument, familiesOf(tokens))
    // Calls are answered in order: whatever is typeset after this is set in
    // these fonts.
    this.worker
      ?.call('fonts', { faces } satisfies FontsPayload)
      .catch((error: unknown) => this.deps.reportError('typeset fonts', error))
  }

  /** Hands the worker the next cards owed — those the overview asked for
   * first, then the rest in board order — once their text is there. */
  private typeset(tokens: TypesetTokens): void {
    const worker = this.worker
    if (!worker || this.pending.size === 0) return
    while (this.inFlight < IN_FLIGHT) {
      const order = [
        ...[...this.wanted].filter((id) => this.pending.has(id)),
        ...this.pending.keys(),
      ]
      const batch: { pending: Pending; card: TypesetCard }[] = []
      for (const id of order) {
        if (batch.length >= BATCH) break
        const pending = this.pending.get(id)
        if (!pending || pending.reading) continue
        const { node } = pending
        if (node.type === 'file' && pending.text === null) {
          this.read(id, pending)
          continue
        }
        this.pending.delete(id)
        const markdown = node.type === 'text' ? node.text : (pending.text ?? '')
        const plain = isPlainText(node)
        batch.push({
          pending,
          card: {
            id,
            markdown: clippedCardMarkdown(node, markdown),
            w: node.w,
            h: node.h,
            plain,
            color:
              plain && node.color !== undefined
                ? this.nodeColor(node.color)
                : null,
          },
        })
      }
      if (batch.length === 0) return
      this.wanted.clear()
      this.inFlight += 1
      const generation = this.generation
      worker
        .call<TypesetResult>('typeset', {
          tokens,
          cards: batch.map((b) => b.card),
        } satisfies TypesetPayload)
        .then(
          (result) => {
            if (generation === this.generation) this.place(batch, result)
          },
          (error: unknown) => this.deps.reportError('typeset', error),
        )
        .finally(() => {
          this.inFlight -= 1
          this.dirty = true
        })
    }
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
    batch: readonly { pending: Pending; card: TypesetCard }[],
    result: TypesetResult,
  ): void {
    const atlas = this.scene.glyphs
    const ids = result.keys.map((key) => {
      const parsed = parseKey(key)
      return parsed.kind === 'icon'
        ? atlas.iconId(parsed.name, parsed.size)
        : atlas.glyphId(parsed.text, parsed.font)
    })
    const sent = new Map(batch.map((b) => [b.card.id, b]))
    for (const typeset of result.cards) {
      const entry = sent.get(typeset.id)
      if (!entry || this.nodes.get(typeset.id) !== entry.pending.node) continue
      const glyphs = new Uint32Array(typeset.glyphs)
      const used = new Set<number>()
      for (let i = 3; i < glyphs.length; i += GLYPH_WORDS) {
        glyphs[i] = ids[glyphs[i]]
        used.add(glyphs[i])
      }
      const { node } = entry.pending
      // Not shown until the overview claims it: it draws the surface.
      const before = this.scene.cardOf(node.id)
      this.scene.setCard(node.id, {
        x: node.x,
        y: node.y,
        w: node.w,
        h: node.h,
        frame: null,
        fade: entry.card.plain ? 0 : FADE,
        content: {
          rects: new Uint32Array(typeset.rects),
          glyphs,
          glyphIds: [...used],
        },
      })
      if (!before) this.scene.setShown(node.id, false)
    }
    // The overview draws their pictures until it asks again.
    this.deps.redrawOverview()
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
