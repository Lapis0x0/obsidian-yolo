/**
 * The Max-state mosaic on the reasoning slider.
 *
 * Two passes over one grid:
 *
 * - The field is a flood: on entering Max a front sweeps right→left and the
 *   field arrives one cell at a time, so the leading edge is scattered squares
 *   that coalesce into a solid field behind it.
 * - On top of the field, sparks. Each spark is born at the "smarter" end and
 *   runs leftward cell by cell, wandering across rows, lighting most (not all)
 *   of the cells it crosses; a lit cell flares fast and cools slowly, so a
 *   spark reads as a short streak with an ember tail. Sparks die after a
 *   random distance, so the far end sees only the few that make it that far.
 *
 * Independent per-cell twinkling was tried first and reads as static noise:
 * with no correlation between neighbouring cells or successive moments the eye
 * finds no direction in it. Sparks carry the direction; the wander, skip, and
 * random reach are what keep it from reading as a mechanical scan.
 *
 * The field pass is a smooth opacity ramp with no dithering: the granularity
 * belongs to the spark pass. Dithering the field itself eats holes in the bar.
 *
 * CSS owns the color (`--yolo-reasoning-field`, carried in through the canvas's
 * own `color`), so the accent follows the theme with no color logic here.
 */

const MAX_DPR = 2
/** Keep painting this long after deactivation so the CSS opacity fade has live
 * frames to fade out, instead of a frozen last frame. */
const FADE_OUT_MS = 360

/**
 * Rows are fixed, columns are derived: the cells have to stay roughly square,
 * and the slider's width varies by surface (the sidebar popover is ~246px, the
 * settings panel is wider). A fixed column count would stretch the grid into
 * slivers or slabs depending on where it renders.
 */
const ROWS = 5
const CELL_GAP_RATIO = 0.18

/** Fallback when the custom property is missing (detached node, jsdom). */
const DEFAULT_FADE = 0.12
const FALLBACK_FIELD = 'rgb(109, 82, 208)'

/** Seconds for the flood front to cross the full width. */
const SWEEP_S = 2.3
/** Per-cell arrival scatter — this is what makes the front edge ragged. */
const ARRIVAL_JITTER_S = 0.18
/** A cell settles into the field before sparks can light it. */
const SPARK_DELAY_S = 0.1

/** Sparks born per second at the "smarter" end. */
const SPARK_RATE = 10.5
/** Spark speed range, in cells per second. */
const SPARK_SPEED_MIN = 8
const SPARK_SPEED_MAX = 18
/** Chance per cell that a spark steps to a neighbouring row. */
const SPARK_WANDER = 0.76
/** Chance per cell that a spark passes without lighting it. */
const SPARK_SKIP = 0.3
/** Mean distance a spark travels, as a share of the width, and its spread. */
const SPARK_REACH = 0.7
const SPARK_REACH_JITTER = 0.6
/** Ember envelope: fast attack, slow release. */
const SPARK_ATTACK = 45
const SPARK_RELEASE = 5
const SPARK_PEAK = 0.9
/**
 * Sparks live on the field: their brightness follows the field's opacity,
 * dropping out well before the field itself dissolves into the track. Below
 * the lower bound nothing is drawn — a lit cell over the bare track reads as
 * noise, not as part of the effect.
 */
const SPARK_FIELD_MIN = 0.02
const SPARK_FIELD_FULL = 0.8
/** Resting glow on every cell — the faint grid texture under the sparks. */
const CELL_REST = 0.05
/**
 * Hard ceiling on the white overlay. White over the field is the one thing
 * here that can out-contrast everything else, so the ceiling stays low —
 * near-opaque white on a saturated field reads as a harsh checkerboard rather
 * than a shimmer.
 */
const CELL_CEILING = 0.62

/** Longest frame delta the spawner will honour, so a stalled tab doesn't
 * release a burst of sparks on resume. */
const MAX_SPAWN_STEP_S = 0.05
/**
 * How far back the spark system is pre-run when the grid is (re)built. The
 * flood front covers the right third of the bar in ~0.3s, far ahead of any
 * spark born at activation, so a cold start reveals a solid slab of field
 * with the sparks trailing in a second later. Pre-running past the longest
 * spark lifetime (reach / slowest speed) means the front uncovers a field
 * already at its steady-state ember density.
 */
const WARM_UP_S = 8

type FieldCell = {
  x: number
  y: number
  width: number
  height: number
  /** Seconds before the flood front reaches this cell. */
  arrival: number
  /** Settled opacity, dissolving toward the "faster" end. */
  alpha: number
}

type SparkCell = {
  x: number
  y: number
  width: number
  height: number
  /**
   * Seconds before this cell is shown. Sparks light cells regardless (they
   * run ahead of activation, see WARM_UP_S); the flood decides when the
   * result becomes visible.
   */
  ready: number
  /** Brightness scale from the field's opacity here; 0 = never drawn. */
  dim: number
  /** Elapsed seconds when this cell was last lit; -Infinity if never. */
  litAt: number
}

type Spark = {
  row: number
  /** Elapsed seconds at birth. */
  born: number
  /** Column position at birth (may start slightly off the right edge). */
  origin: number
  /** Cells per second. */
  speed: number
  /** Next column the spark will cross. */
  nextCol: number
  /** Column position at which the spark dies. */
  dieAt: number
}

function hash(col: number, row: number, salt: number): number {
  const value = Math.sin(col * 127.1 + row * 311.7 + salt * 74.7) * 43758.5453
  return value - Math.floor(value)
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * Settled field opacity across the bar. The long dissolve toward "faster" is
 * what remains visible once the flood has finished.
 */
function fieldProfile(x: number, fade: number): number {
  const stops: [number, number][] = [
    [0.04 + fade, 0],
    [0.26 + fade, 0.34],
    [0.52 + fade, 0.82],
    [0.78 + fade, 1],
  ]
  if (x <= stops[0][0]) return 0
  for (let i = 1; i < stops.length; i++) {
    const [prevX, prevValue] = stops[i - 1]
    const [nextX, nextValue] = stops[i]
    if (x > nextX) continue
    const t = (x - prevX) / (nextX - prevX)
    return prevValue + (nextValue - prevValue) * t
  }
  return 1
}

/**
 * The front decelerates as it travels (ease-out cubic), so `arrival` is that
 * curve inverted: the time at which the front reaches `x`.
 */
function arrivalAt(x: number): number {
  return SWEEP_S * (1 - Math.cbrt(x))
}

export class ReasoningSparkRenderer {
  private readonly ownerDocument: Document
  private readonly ownerWindow: Window
  private readonly resizeObserver: ResizeObserver
  private readonly context: CanvasRenderingContext2D | null
  private fieldCells: FieldCell[] = []
  /** Row-major, `columns` per row. */
  private sparkCells: SparkCell[] = []
  private columns = 0
  private sparks: Spark[] = []
  private spawnDebt = 0
  private lastSpawnElapsed = 0
  /** Set whenever the grid is rebuilt; the next frame pre-runs the sparks. */
  private sparksCold = true
  private fieldColor = FALLBACK_FIELD
  private fade = DEFAULT_FADE
  private animationFrame: number | null = null
  private active = false
  private destroyed = false
  private activationStartedAt = 0
  private pausedAt: number | null = null
  private stopAfter = 0

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ownerDocument = canvas.ownerDocument
    const ownerWindow = this.ownerDocument.defaultView
    if (!ownerWindow) throw new Error('Canvas has no owner window')
    this.ownerWindow = ownerWindow
    this.context = canvas.getContext('2d')
    this.resizeObserver = new ownerWindow.ResizeObserver(this.handleResize)
    this.resizeObserver.observe(canvas)
    this.ownerDocument.addEventListener(
      'visibilitychange',
      this.handleVisibilityChange,
    )
  }

  setActive(active: boolean): void {
    if (this.destroyed || this.active === active) return
    this.active = active
    const now = this.ownerWindow.performance.now()

    if (active) {
      this.activationStartedAt = now
      this.stopAfter = Number.POSITIVE_INFINITY
      this.readStyle()
      this.measure()
      this.startLoop()
      return
    }

    this.stopAfter = now + FADE_OUT_MS
    this.startLoop()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.stopLoop()
    this.resizeObserver.disconnect()
    this.ownerDocument.removeEventListener(
      'visibilitychange',
      this.handleVisibilityChange,
    )
    this.fieldCells = []
    this.sparkCells = []
    this.sparks = []
  }

  private readonly handleResize = (): void => {
    this.measure()
    if (this.active) this.startLoop()
  }

  private readonly handleVisibilityChange = (): void => {
    const now = this.ownerWindow.performance.now()
    if (this.ownerDocument.hidden) {
      this.pausedAt = now
      this.stopLoop()
      return
    }

    if (this.pausedAt !== null && this.active) {
      this.activationStartedAt += now - this.pausedAt
    }
    this.pausedAt = null
    if (this.active || now < this.stopAfter) this.startLoop()
  }

  /**
   * The canvas renders no text, so its `color` is free to carry the field
   * color in — and unlike reading the custom property directly, the platform
   * hands back a fully resolved color function that `fillStyle` accepts. The
   * fade offset rides along the same way, so the field profile here and the
   * CSS that documents it can't drift apart.
   *
   * Read once per activation: the slider only lives as long as its popover, so
   * an accent change lands the next time it opens.
   */
  private readStyle(): void {
    const computed = this.ownerWindow.getComputedStyle(this.canvas)
    // Chromium resolves color-mix() to `color(srgb ...)`, not `rgb(...)`, and
    // fillStyle takes either — so hand the string over as-is rather than
    // sniffing its format.
    const color = computed.color.trim()
    this.fieldColor = color && color !== 'transparent' ? color : FALLBACK_FIELD
    const parsed = Number.parseFloat(
      computed.getPropertyValue('--yolo-reasoning-fade'),
    )
    this.fade = Number.isFinite(parsed) ? parsed / 100 : DEFAULT_FADE
  }

  /**
   * Everything that depends only on cell position — placement, arrival,
   * brightness scales — is resolved here, so a frame is left with an
   * exponential or two and a `fillRect` per cell.
   */
  private measure(): void {
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const dpr = Math.min(this.ownerWindow.devicePixelRatio || 1, MAX_DPR)
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr))
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr))

    const cellHeight = this.canvas.height / ROWS
    const columns = Math.max(2, Math.round(this.canvas.width / cellHeight))
    const cellWidth = this.canvas.width / columns
    // Proportional gap with only a sub-pixel floor: a fixed floor eats the
    // cell itself once the grid gets dense.
    const gap = Math.max(
      dpr * 0.5,
      Math.min(cellWidth, cellHeight) * CELL_GAP_RATIO,
    )

    const fieldCells: FieldCell[] = []
    const sparkCells: SparkCell[] = []
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < columns; col++) {
        const x = col / (columns - 1)
        const arrival = arrivalAt(x) + hash(col, row, 3) * ARRIVAL_JITTER_S

        // Field cells tile with no gap, so behind the front they read as one
        // continuous field rather than a grid. Snap edges to device pixels so
        // they meet exactly.
        const left = Math.round(col * cellWidth)
        const top = Math.round(row * cellHeight)
        const alpha = fieldProfile(x, this.fade)
        if (alpha > 0.012) {
          fieldCells.push({
            x: left,
            y: top,
            width: Math.round((col + 1) * cellWidth) - left,
            height: Math.round((row + 1) * cellHeight) - top,
            arrival,
            alpha,
          })
        }

        // Round each inset edge independently rather than rounding the gap:
        // rounding the gap first costs up to a whole device pixel off every
        // side, which is a lot when a cell is only ~9 device pixels wide.
        const insetLeft = Math.round(col * cellWidth + gap / 2)
        const insetTop = Math.round(row * cellHeight + gap / 2)
        sparkCells.push({
          x: insetLeft,
          y: insetTop,
          width: Math.max(
            1,
            Math.round((col + 1) * cellWidth - gap / 2) - insetLeft,
          ),
          height: Math.max(
            1,
            Math.round((row + 1) * cellHeight - gap / 2) - insetTop,
          ),
          ready: arrival + SPARK_DELAY_S,
          dim: smoothstep(SPARK_FIELD_MIN, SPARK_FIELD_FULL, alpha),
          litAt: Number.NEGATIVE_INFINITY,
        })
      }
    }
    this.fieldCells = fieldCells
    this.sparkCells = sparkCells
    this.columns = columns
    // Sparks index into the old grid; the next frame re-seeds them on this one.
    this.sparksCold = true
  }

  private startLoop(): void {
    if (
      this.animationFrame !== null ||
      this.destroyed ||
      !this.context ||
      this.ownerDocument.hidden ||
      this.fieldCells.length === 0
    ) {
      return
    }
    this.animationFrame = this.ownerWindow.requestAnimationFrame(this.render)
  }

  private stopLoop(): void {
    if (this.animationFrame === null) return
    this.ownerWindow.cancelAnimationFrame(this.animationFrame)
    this.animationFrame = null
  }

  private spawnSpark(elapsed: number): void {
    const columns = this.columns
    const reach =
      columns *
      SPARK_REACH *
      (1 + (Math.random() - 0.5) * 2 * SPARK_REACH_JITTER)
    this.sparks.push({
      row: Math.floor(Math.random() * ROWS),
      born: elapsed,
      // A little past the edge, so sparks born on the same frame don't enter
      // in lockstep.
      origin: columns - 1 + Math.random() * 1.5,
      speed:
        SPARK_SPEED_MIN + Math.random() * (SPARK_SPEED_MAX - SPARK_SPEED_MIN),
      nextCol: columns - 1,
      dieAt: columns - 1 - reach,
    })
  }

  /** Replay the spark system over the WARM_UP_S seconds leading up to `elapsed`. */
  private warmUpSparks(elapsed: number): void {
    this.sparks = []
    this.spawnDebt = 0
    this.lastSpawnElapsed = elapsed - WARM_UP_S
    for (let t = this.lastSpawnElapsed; t < elapsed; t += MAX_SPAWN_STEP_S) {
      this.advanceSparks(t)
    }
    this.sparksCold = false
  }

  /**
   * Advance every spark to `elapsed`, lighting the cells it crossed. Position
   * is analytic in elapsed time rather than integrated per frame, so a paused
   * tab or a dropped frame just skips ahead instead of drifting.
   */
  private advanceSparks(elapsed: number): void {
    const step = Math.min(
      MAX_SPAWN_STEP_S,
      Math.max(0, elapsed - this.lastSpawnElapsed),
    )
    this.lastSpawnElapsed = elapsed
    this.spawnDebt += SPARK_RATE * step
    while (this.spawnDebt >= 1) {
      this.spawnDebt -= 1
      this.spawnSpark(elapsed)
    }

    const columns = this.columns
    const cells = this.sparkCells
    this.sparks = this.sparks.filter((spark) => {
      const position = spark.origin - spark.speed * (elapsed - spark.born)
      while (position <= spark.nextCol && spark.nextCol >= 0) {
        if (Math.random() >= SPARK_SKIP) {
          cells[spark.row * columns + spark.nextCol].litAt = elapsed
        }
        if (Math.random() < SPARK_WANDER) {
          const direction = Math.random() < 0.5 ? -1 : 1
          spark.row = Math.max(0, Math.min(ROWS - 1, spark.row + direction))
        }
        spark.nextCol--
      }
      return spark.nextCol >= 0 && position > spark.dieAt
    })
  }

  private readonly render = (now: number): void => {
    this.animationFrame = null
    const ctx = this.context
    if (!ctx) return

    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    const elapsed = (now - this.activationStartedAt) / 1000

    ctx.fillStyle = this.fieldColor
    for (const cell of this.fieldCells) {
      const age = elapsed - cell.arrival
      if (age <= 0) continue
      // Land fast (~125ms) so an arriving cell reads as a square dropping in,
      // not as a slow tint.
      const alpha = cell.alpha * Math.min(1, age * 8)
      if (alpha <= 0.012) continue
      ctx.globalAlpha = alpha
      ctx.fillRect(cell.x, cell.y, cell.width, cell.height)
    }

    if (this.sparksCold) this.warmUpSparks(elapsed)
    this.advanceSparks(elapsed)

    ctx.fillStyle = '#ffffff'
    for (const cell of this.sparkCells) {
      if (cell.dim <= 0 || elapsed <= cell.ready) continue
      const age = elapsed - cell.litAt
      const alpha = Math.min(
        CELL_CEILING,
        cell.dim *
          (CELL_REST +
            SPARK_PEAK *
              Math.exp(-age * SPARK_RELEASE) *
              (1 - Math.exp(-age * SPARK_ATTACK))),
      )
      if (alpha <= 0.012) continue
      ctx.globalAlpha = alpha
      ctx.fillRect(cell.x, cell.y, cell.width, cell.height)
    }
    ctx.globalAlpha = 1

    if (this.active || now < this.stopAfter) this.startLoop()
  }
}
