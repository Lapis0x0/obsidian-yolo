// The minimap: the whole board in the bottom-right corner of the viewport,
// with a frame around the part of it on screen. Zoomed in to read, the board
// around what is being read is out of sight; this keeps it in view, and a
// press on it takes the camera there.
//
// It shows only when it has something to add — outside the overview tier,
// and while the board does not fit on screen. Zoomed out that far, the board
// itself is the overview.
//
// Two canvases, stacked. The board is drawn on the lower one by the overview
// tier's own drawing (./overviewLayer.ts's `paintBoard`), so the two show the
// board the same way, and only when what the board shows changes — which the
// overview layer's `revision` says — at most every BOARD_REDRAW_INTERVAL_MS
// while a drag keeps changing it. The upper one holds the viewport — the rest
// of the board washed back, the part on screen left clear — which moves with
// every frame of the camera and costs a few rectangles.
//
// Lives in the selection toolbar's overlay with the rest of the screen-space
// chrome, so a press on it is a press on chrome and never on the board
// (ToolbarController's `isOverlayTarget`).
//
// Popout safety: every element and listener belongs to the document handed
// in, and the pixel ratio and computed style come from its window.

import {
  type ScreenPoint,
  type WorldRect,
  fitViewToBounds,
  screenToWorld,
  unionRect,
} from '../../domain/camera'
import type { BoardNode } from '../../domain/fileFormat'
import {
  type CanvasView,
  computeWorldViewportRect,
} from '../../domain/virtualization'
import { findStatusBar, statusBarLift } from '../statusBarClearance'

const MINIMAP_CLASS = 'yolo-whiteboard-minimap'
const MINIMAP_SHOWN_CLASS = 'yolo-whiteboard-minimap-shown'
const MINIMAP_DRAGGING_CLASS = 'yolo-whiteboard-minimap-dragging'
const MINIMAP_CANVAS_CLASS = 'yolo-whiteboard-minimap-canvas'
const LIFT_PROPERTY = '--yolo-whiteboard-minimap-lift'

/** The minimap's inside, in CSS pixels — minimap.css's size, which the
 * drawing and the pointer both map through. */
const MINIMAP_WIDTH_PX = 200
const MINIMAP_HEIGHT_PX = 140
/** Room kept around the board inside the minimap. */
const MINIMAP_PADDING_PX = 8
/** How often a board that keeps changing — a card being dragged — is drawn
 * again. The frame follows the camera every frame regardless. */
const BOARD_REDRAW_INTERVAL_MS = 100
/** The smallest the frame is drawn: on a large board zoomed in to read, the
 * screen is a speck of it, and a speck is not something to find or grab. */
const MIN_FRAME_PX = 6
/** A press that travels less than this is a press, which glides the camera
 * over; past it, the camera follows the pointer. */
const DRAG_SLOP_PX = 3
/** The board outside the viewport is washed back in two coats: faded into
 * the minimap's background, which quietens what is drawn there, then tinted
 * with the theme's text colour, which is what sets it apart — fading a white
 * board into a white background alone changes nothing to see (React Flow's
 * mask is a grey distinct from its background for the same reason). The
 * tint greys a light theme and hazes a dark one: either way, the part on
 * screen is the one left clear. */
const MASK_FADE_ALPHA = 0.5
const MASK_TINT_ALPHA = 0.08
/** The viewport's edge, in the theme's muted text colour — faint at rest,
 * enough to find over an empty stretch of board; stronger while the pointer
 * is over the minimap or dragging it, which is when it is being grabbed. */
const EDGE_ALPHA = 0.5
const EDGE_ACTIVE_ALPHA = 0.85

/** Any scale at all: the minimap fits the board, however big or small. */
const ANY_SCALE = Object.freeze({ min: 0, max: Number.POSITIVE_INFINITY })

type Size = Readonly<{ width: number; height: number }>

export type MinimapCallbacks = Readonly<{
  /** Whether the minimap is switched on (MinimapPrefs). */
  isEnabled: () => boolean
  getView: () => CanvasView
  getViewportSize: () => Size
  /** Every node on the board, groups included: what the minimap fits. */
  getNodes: () => readonly BoardNode[]
  isOverview: () => boolean
  /** Changes whenever what the board shows does (OverviewLayer's
   * `revision`). */
  getRevision: () => number
  paintBoard: (
    ctx: CanvasRenderingContext2D,
    view: CanvasView,
    size: Size,
  ) => void
  centerOn: (world: ScreenPoint, options: Readonly<{ glide: boolean }>) => void
}>

export class Minimap {
  private readonly el: HTMLElement
  private readonly boardCanvas: HTMLCanvasElement
  private readonly frameCanvas: HTMLCanvasElement
  private shown = false
  /** The board's extent and the view that fits it into the minimap, as of
   * `drawnRevision`; null while the board is empty. */
  private bounds: WorldRect | null = null
  private mapView: CanvasView | null = null
  private drawnRevision = -1
  private lastBoardDraw = Number.NEGATIVE_INFINITY
  /** The board picture is behind the board: drawn next time it is shown. */
  private boardStale = true
  /** What the frame was last drawn for — see `render`. */
  private framedView: CanvasView | null = null
  private framedWidth = 0
  private framedHeight = 0
  /** The theme colours the frame is drawn in, read with the board. */
  private maskColor = ''
  private tintColor = ''
  private edgeColor = ''
  private hovered = false
  private press: {
    pointerId: number
    start: ScreenPoint
    /** Where on the board the pointer holds the viewport, from its middle. */
    offset: ScreenPoint
    dragging: boolean
  } | null = null
  private readonly resizeObserver: ResizeObserver | null

  constructor(
    private readonly doc: Document,
    private readonly parent: HTMLElement,
    private readonly callbacks: MinimapCallbacks,
  ) {
    const el = doc.createElement('div')
    el.className = MINIMAP_CLASS
    this.boardCanvas = doc.createElement('canvas')
    this.frameCanvas = doc.createElement('canvas')
    for (const canvas of [this.boardCanvas, this.frameCanvas]) {
      canvas.className = MINIMAP_CANVAS_CLASS
      el.appendChild(canvas)
    }
    parent.appendChild(el)
    this.el = el
    el.addEventListener('pointerdown', this.onPointerDown)
    el.addEventListener('pointermove', this.onPointerMove)
    el.addEventListener('pointerup', this.onPointerEnd)
    el.addEventListener('pointercancel', this.onPointerEnd)
    el.addEventListener('pointerenter', this.onPointerEnter)
    el.addEventListener('pointerleave', this.onPointerLeave)
    const win = doc.defaultView
    this.resizeObserver = win
      ? new win.ResizeObserver(this.syncPlacement)
      : null
    this.resizeObserver?.observe(parent)
    const statusBar = findStatusBar(doc)
    if (statusBar) {
      this.resizeObserver?.observe(statusBar, { box: 'border-box' })
    }
  }

  /** Called once per frame from the canvas's rAF loop, after the camera and
   * the overview have been drawn. A still board and a still camera cost a
   * few comparisons. */
  render(now: number): void {
    const revision = this.callbacks.getRevision()
    if (
      revision !== this.drawnRevision &&
      now - this.lastBoardDraw >= BOARD_REDRAW_INTERVAL_MS
    ) {
      this.drawnRevision = revision
      this.lastBoardDraw = now
      this.bounds = unionRect(this.callbacks.getNodes())
      this.mapView = this.bounds
        ? fitViewToBounds(
            this.bounds,
            { width: MINIMAP_WIDTH_PX, height: MINIMAP_HEIGHT_PX },
            MINIMAP_PADDING_PX,
            ANY_SCALE,
          )
        : null
      this.boardStale = true
    }
    const view = this.callbacks.getView()
    const size = this.callbacks.getViewportSize()
    this.setShown(this.wanted(view, size))
    if (!this.shown || !this.mapView) return
    const redrawn = this.boardStale
    if (redrawn) {
      this.drawBoard(this.mapView)
      this.boardStale = false
    }
    if (
      redrawn ||
      view !== this.framedView ||
      size.width !== this.framedWidth ||
      size.height !== this.framedHeight
    ) {
      this.drawFrame(this.mapView, view, size)
    }
  }

  destroy(): void {
    this.resizeObserver?.disconnect()
    this.el.removeEventListener('pointerdown', this.onPointerDown)
    this.el.removeEventListener('pointermove', this.onPointerMove)
    this.el.removeEventListener('pointerup', this.onPointerEnd)
    this.el.removeEventListener('pointercancel', this.onPointerEnd)
    this.el.removeEventListener('pointerenter', this.onPointerEnter)
    this.el.removeEventListener('pointerleave', this.onPointerLeave)
    this.el.remove()
  }

  /** Whether the minimap has anything to add: outside the overview tier, on
   * a board that does not fit on screen. */
  private wanted(view: CanvasView, size: Size): boolean {
    const bounds = this.bounds
    if (!bounds || !this.callbacks.isEnabled()) return false
    if (this.callbacks.isOverview()) return false
    if (!(size.width > 0) || !(size.height > 0)) return false
    const screen = computeWorldViewportRect(size.width, size.height, view, 0)
    return !(
      screen.left <= bounds.x &&
      screen.top <= bounds.y &&
      screen.right >= bounds.x + bounds.w &&
      screen.bottom >= bounds.y + bounds.h
    )
  }

  private setShown(shown: boolean): void {
    if (shown === this.shown) return
    this.shown = shown
    this.el.classList.toggle(MINIMAP_SHOWN_CLASS, shown)
    // The frame is only drawn while shown, so the one it holds is from
    // whenever it was last on screen.
    this.framedView = null
    if (shown) this.syncPlacement()
  }

  private drawBoard(mapView: CanvasView): void {
    const ctx = this.prepare(this.boardCanvas)
    if (!ctx) return
    this.callbacks.paintBoard(ctx, mapView, {
      width: MINIMAP_WIDTH_PX,
      height: MINIMAP_HEIGHT_PX,
    })
    // Read with the board: a theme change is one of the things that redraws
    // it (OverviewLayer's `revision`).
    const style = this.doc.defaultView?.getComputedStyle(this.el)
    this.maskColor =
      style?.getPropertyValue('--background-primary').trim() || '#ffffff'
    this.tintColor =
      style?.getPropertyValue('--text-normal').trim() || '#222222'
    this.edgeColor = style?.getPropertyValue('--text-muted').trim() || '#5c5c5c'
  }

  /**
   * Where the viewport is, shown the way React Flow's minimap shows it: the
   * rest of the board washed back and greyed (MASK_FADE_ALPHA /
   * MASK_TINT_ALPHA), the part on screen left clear, and a faint neutral
   * edge around it. Not the accent colour,
   * which on this board means "selected" — the minimap draws selected cards
   * in it too. Held inside the minimap, so a camera that has wandered off
   * the board still shows which way it went.
   */
  private drawFrame(mapView: CanvasView, view: CanvasView, size: Size): void {
    this.framedView = view
    this.framedWidth = size.width
    this.framedHeight = size.height
    const ctx = this.prepare(this.frameCanvas)
    if (!ctx) return
    const screen = computeWorldViewportRect(size.width, size.height, view, 0)
    const left = screen.left * mapView.scale + mapView.tx
    const top = screen.top * mapView.scale + mapView.ty
    const w = Math.min(
      MINIMAP_WIDTH_PX,
      Math.max(MIN_FRAME_PX, (screen.right - screen.left) * mapView.scale),
    )
    const h = Math.min(
      MINIMAP_HEIGHT_PX,
      Math.max(MIN_FRAME_PX, (screen.bottom - screen.top) * mapView.scale),
    )
    const x = clamp(left, 0, MINIMAP_WIDTH_PX - w)
    const y = clamp(top, 0, MINIMAP_HEIGHT_PX - h)
    ctx.fillStyle = this.maskColor
    ctx.globalAlpha = MASK_FADE_ALPHA
    ctx.fillRect(0, 0, MINIMAP_WIDTH_PX, MINIMAP_HEIGHT_PX)
    ctx.fillStyle = this.tintColor
    ctx.globalAlpha = MASK_TINT_ALPHA
    ctx.fillRect(0, 0, MINIMAP_WIDTH_PX, MINIMAP_HEIGHT_PX)
    ctx.clearRect(x, y, w, h)
    ctx.globalAlpha =
      this.hovered || this.press !== null ? EDGE_ACTIVE_ALPHA : EDGE_ALPHA
    ctx.strokeStyle = this.edgeColor
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
    ctx.globalAlpha = 1
  }

  /** The pointer came onto the minimap or left it, or a drag began or
   * ended: the edge changes strength, so the next frame draws it again. */
  private refreshEdge(): void {
    this.framedView = null
  }

  /** Sizes a canvas's backing store for the display it is on, and hands
   * back its context cleared and scaled to CSS pixels. */
  private prepare(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const dpr = this.doc.defaultView?.devicePixelRatio || 1
    const w = Math.round(MINIMAP_WIDTH_PX * dpr)
    const h = Math.round(MINIMAP_HEIGHT_PX * dpr)
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, MINIMAP_WIDTH_PX, MINIMAP_HEIGHT_PX)
    return ctx
  }

  /** Where on the board a pointer over the minimap is. */
  private worldAt(e: PointerEvent, mapView: CanvasView): ScreenPoint {
    const rect = this.frameCanvas.getBoundingClientRect()
    return screenToWorld(mapView, {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    })
  }

  /**
   * A press inside the frame takes hold of it, so dragging moves the
   * viewport the way the hand moves the frame. A press anywhere else glides
   * the camera to centre there, and a drag that follows carries on from it.
   */
  private readonly onPointerDown = (e: PointerEvent): void => {
    const mapView = this.mapView
    if (e.button !== 0 || !this.shown || !mapView) return
    e.preventDefault()
    e.stopPropagation()
    const world = this.worldAt(e, mapView)
    const size = this.callbacks.getViewportSize()
    const screen = computeWorldViewportRect(
      size.width,
      size.height,
      this.callbacks.getView(),
      0,
    )
    const inside =
      world.x >= screen.left &&
      world.x <= screen.right &&
      world.y >= screen.top &&
      world.y <= screen.bottom
    const offset = inside
      ? {
          x: world.x - (screen.left + screen.right) / 2,
          y: world.y - (screen.top + screen.bottom) / 2,
        }
      : { x: 0, y: 0 }
    if (!inside) this.callbacks.centerOn(world, { glide: true })
    this.press = {
      pointerId: e.pointerId,
      start: { x: e.clientX, y: e.clientY },
      offset,
      dragging: false,
    }
    this.el.setPointerCapture(e.pointerId)
    this.el.classList.add(MINIMAP_DRAGGING_CLASS)
    this.refreshEdge()
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    const press = this.press
    const mapView = this.mapView
    if (!press || e.pointerId !== press.pointerId || !mapView) return
    e.preventDefault()
    if (!press.dragging) {
      const travelled = Math.hypot(
        e.clientX - press.start.x,
        e.clientY - press.start.y,
      )
      if (travelled < DRAG_SLOP_PX) return
      press.dragging = true
    }
    const world = this.worldAt(e, mapView)
    this.callbacks.centerOn(
      { x: world.x - press.offset.x, y: world.y - press.offset.y },
      { glide: false },
    )
  }

  private readonly onPointerEnd = (e: PointerEvent): void => {
    const press = this.press
    if (!press || e.pointerId !== press.pointerId) return
    this.press = null
    if (this.el.hasPointerCapture(e.pointerId)) {
      this.el.releasePointerCapture(e.pointerId)
    }
    this.el.classList.remove(MINIMAP_DRAGGING_CLASS)
    this.refreshEdge()
  }

  private readonly onPointerEnter = (): void => {
    this.hovered = true
    this.refreshEdge()
  }

  private readonly onPointerLeave = (): void => {
    this.hovered = false
    this.refreshEdge()
  }

  /** Stands the minimap clear of the status bar when it floats over the
   * minimap's corner (../statusBarClearance.ts). */
  private readonly syncPlacement = (): void => {
    const area = this.parent.getBoundingClientRect()
    const bar = findStatusBar(this.doc)?.getBoundingClientRect()
    const lift = statusBarLift(
      area,
      bar,
      area.right - MINIMAP_WIDTH_PX,
      area.right,
    )
    this.el.style.setProperty(LIFT_PROPERTY, `${lift}px`)
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
