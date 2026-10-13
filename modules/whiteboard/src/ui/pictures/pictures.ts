// Small pictures of what a board shows, held for it: a PDF's pages
// (./pdfPages.ts), and whatever else a source here makes a picture of.
//
// A spread puts hundreds of pages on the board, and a page's real picture is
// drawn only once it is on screen, at the density the screen shows it — which
// on a pan across a spread is later than the page arrives, so pages came in
// blank. And zoomed out past the overview threshold nothing is drawn at all:
// the overview canvas showed each card as a grey one.
//
// So everything a source can picture gets a picture, nearest the middle of
// the viewport first. A card shows its picture until its own content is
// ready, and the overview canvas draws pictures where it drew grey.
//
// A picture is made once per version of what it is of: it is kept on this
// device (host/pictureStore.ts), and one that is kept there is read back
// instead — at any time, since that costs its maker nothing. Making one waits
// for the board to be still, and for its source's turn (`PictureTurn`): a
// PDF page goes through the board's draw queue as one client behind every
// reader, so a page on screen is never kept waiting for a picture's turn.
//
// What is held here is only what the board shows: a spread folded away lets
// go of its pictures, and over the budget the ones furthest from the viewport
// do.
//
// And each at the size it is shown at (`LEVELS`), not the size it is kept
// at: zoomed out, a page is a few dozen pixels wide and the screen holds
// hundreds of them, so a picture held whole costs many times what it shows.
// Held at the smallest level that covers it on screen, what the pictures take
// follows the screen's pixels rather than their number — four spreads side by
// side at 7% had outgrown the budget at full size, and fit in a quarter of it
// this way.
//
// With each picture goes what its maker keeps beside it (`meta`) — for a PDF
// page, where its PDF points land on it, which the overview draws its
// annotations by without opening the PDF.

import type { PictureStore, StoredPicture } from '../../host/pictureStore'

/** The fractions of its full width a picture is held at: the smallest that
 * covers it as the screen shows it (`levelFor`). The device keeps it whole,
 * and a smaller one is decoded from it — which costs no more than decoding it
 * whole — or scaled down from the one held. */
const LEVELS = [0.25, 0.5, 1] as const
/** How much the pictures held may take, in bytes: about 360 PDF pages at the
 * largest level, and far more at the ones a zoomed-out board holds. */
const BUDGET_BYTES = 48 * 1024 * 1024
/** Pictures brought down to a smaller level at once. */
const SHRINKS_AT_ONCE = 24
/** Pictures read back from the device at once. */
const READS_AT_ONCE = 6
/** How often the wanted pictures are looked over while the board moves: as
 * often as the board itself looks again at what is on screen (constants.ts's
 * RECOMPUTE_INTERVAL_MS). Nothing is made until it is still, and a look over
 * every page of every open spread, each frame, was the costliest thing a pan
 * across a large spread did. */
const SCAN_INTERVAL_MOVING_MS = 70
/** How a picture is kept: a few kilobytes each. A WebView that cannot write
 * it gives PNG, which is larger and as good. */
const ENCODING = 'image/webp'
const ENCODING_QUALITY = 0.8

export type PictureSourceId = 'pdf' | 'image' | 'card'

/** Which picture: of what source, in which of its groups (host/
 * pictureStore.ts), under which key there. */
export type PictureRef = Readonly<{
  source: PictureSourceId
  group: string
  key: string
}>

/** A picture the board wants: how wide what it stands for is on the board,
 * and how far that is from the middle of the viewport (both in world units),
 * and what it has to have been made from (`StoredPicture.stamp`). */
export type WantedPicture = PictureRef &
  Readonly<{
    width: number
    distance: number
    stamp: string
  }>

/** A wanted picture, and how many device pixels wide it is shown now. */
type Want = WantedPicture & Readonly<{ screen: number }>

/** A picture a source has made, whole: the scheduler holds, keeps and then
 * empties the canvas. */
export type DrawnPicture = Readonly<{
  canvas: HTMLCanvasElement
  meta: unknown
}>

/**
 * When a source may make its next picture. Asked only while the board is
 * still and the source is making none.
 */
export type PictureTurn = Readonly<{
  /** Whether `next` may be made now. On no, `wake` is called once it may,
   * and it is asked again. */
  begin(next: WantedPicture, wake: () => void): boolean
  /** A picture `begin` allowed has been made, however it ended. */
  end(): void
  /** No picture is wanted from this source for now. */
  withdraw(): void
}>

/** What makes one kind of picture. */
export type PictureSource = Readonly<{
  id: PictureSourceId
  store: PictureStore
  /** What its errors are reported as. */
  label: string
  turn: PictureTurn
  /** The version of `group` now (`PictureStore`); null when there is
   * nothing there to picture. */
  version(group: string): number | null
  /**
   * Makes a picture of this version of its group: null when it cannot be
   * made now and should be asked for again, 'unavailable' when it cannot be
   * made at all until its group changes. Throws when making it failed.
   */
  draw(
    want: WantedPicture,
    version: number,
  ): Promise<DrawnPicture | 'unavailable' | null>
  /** Whether `want` can be made now at all; one that cannot is not waited
   * for (the board says when that may have changed: `invalidate`). */
  canDraw?(want: WantedPicture): boolean
  /** How many pictures it may be making at once, nearest first; one when
   * left out. More than one for a source whose making is mostly waiting,
   * so that the waits run side by side. */
  concurrency?: number
  /** Waits for a moment to keep what was drawn in — encoding it costs the
   * main thread a few milliseconds more, which a source drawing in idle
   * slices (./idle.ts) has already spent: true then, false if the board
   * closed first. Without it, what is drawn is kept at once. */
  settle?(): Promise<boolean>
  /** A group is no longer wanted: whatever the source holds open for it
   * goes. */
  release?(group: string): void
  /** The filter a dark theme shows this source's pictures through, baked
   * once per picture when first asked for. */
  darkFilter?: string
}>

export type PicturesDeps = Readonly<{
  doc: Document
  sources: readonly PictureSource[]
  /** Every picture the board wants, now. */
  wanted: () => Iterable<WantedPicture>
  /** Device pixels per world unit, as the board is shown now. */
  resolution: () => number
  /** Whether the board is still: pictures are made only then. */
  idle: () => boolean
  /** A picture arrived (`key`), or a group's were all dropped (null). */
  onChange: (source: PictureSourceId, group: string, key: string | null) => void
  /** Whether there are pictures to make — being made, or waiting for the
   * board to be still or for their source's turn — changed. */
  onBusy?: (busy: boolean) => void
  reportError: (stage: string, error: unknown) => void
  /** Only tests set this. */
  budgetBytes?: number
}>

type Entry = {
  bitmap: ImageBitmap
  /** Which of `LEVELS` the bitmap is. */
  level: number
  /** How wide the picture is whole, in pixels. */
  fullWidth: number
  stamp: string
  /** The same picture as a dark theme shows it, made when first asked
   * for. */
  dark: ImageBitmap | null
}

/** A group whose pictures are wanted: the version they are of, and what of
 * it the device has. */
type GroupState = {
  readonly source: PictureSource
  readonly group: string
  readonly version: number
  /** The pictures kept on the device; null until the store has answered. */
  stored: Map<string, StoredPicture> | null
  /** What each picture's maker kept beside it, for the pictures there
   * are. */
  readonly metas: Map<string, unknown>
}

const groupKey = (source: PictureSourceId, group: string): string =>
  `${source}\u0000${group}`
const refKey = (ref: PictureRef): string =>
  `${groupKey(ref.source, ref.group)}\u0000${ref.key}`

export class Pictures {
  private readonly entries = new Map<string, Entry>()
  private readonly groups = new Map<string, GroupState>()
  private readonly sources = new Map<PictureSourceId, PictureSource>()
  /** Pictures that could not be made, by the stamp they were asked with:
   * not asked for again until their group or their stamp changes. */
  private readonly failed = new Map<string, string>()
  /** Pictures being read back from the device. */
  private readonly reading = new Set<string>()
  /** Pictures being brought down to a smaller level. */
  private readonly shrinking = new Set<string>()
  /** The pictures being made now, by their source. */
  private readonly drawing = new Map<string, PictureSourceId>()
  private bytes = 0
  private destroyed = false
  /** Nothing has happened since the last look that could change what it
   * found — at `completeAt`'s resolution, with the board as still as
   * `completeIdle` says: no look is needed until something does. What can
   * change it is the board (`retain`, `invalidate`), the zoom, the board
   * coming to rest, and a read, a draw, a shrink or a store's answer landing
   * — each of which says so. A look finds either that every picture is held,
   * or the most that can be started now; the rest waits on those.
   *
   * Not "every picture is held": past the budget that is never true, and a
   * still board with more pictures than it can hold was looked over in full
   * every frame — three thousand cards' worth, for nothing. */
  private complete = false
  private completeAt = 0
  private completeIdle = false
  private lastScanAt = Number.NEGATIVE_INFINITY
  /** What was last told `onBusy`. */
  private busy = false
  private readonly budget: number
  private readonly wake = (): void => {
    this.complete = false
    this.pump()
  }

  constructor(private readonly deps: PicturesDeps) {
    for (const source of deps.sources) this.sources.set(source.id, source)
    this.budget = deps.budgetBytes ?? BUDGET_BYTES
  }

  /** The picture, as a dark theme shows it when `dark`; null while there is
   * none. */
  get(ref: PictureRef, dark = false): ImageBitmap | null {
    const entry = this.entries.get(refKey(ref))
    if (!entry) return null
    const filter = this.sources.get(ref.source)?.darkFilter
    if (!dark || !filter) return entry.bitmap
    if (!entry.dark) {
      entry.dark = this.filtered(entry.bitmap, filter)
      if (entry.dark) {
        this.bytes += bitmapBytes(entry.dark)
        // Past the budget now, maybe: the farthest goes on the next look.
        this.complete = false
      }
    }
    return entry.dark ?? entry.bitmap
  }

  /** What the picture's maker kept beside it; null while there is none. */
  meta(ref: PictureRef): unknown {
    return (
      this.groups.get(groupKey(ref.source, ref.group))?.metas.get(ref.key) ??
      null
    )
  }

  /**
   * Reads back the nearest pictures the device has, and makes the next one
   * it has not if the board is idle and it is that source's turn. Called by
   * the board once a frame, and by a turn when one opens; cheap when there is
   * nothing to do.
   */
  pump(): void {
    if (this.destroyed) return
    const resolution = this.deps.resolution()
    const idle = this.deps.idle()
    if (
      this.complete &&
      resolution === this.completeAt &&
      idle === this.completeIdle
    ) {
      return
    }
    const now = this.deps.doc.defaultView?.performance.now() ?? 0
    if (!idle && now - this.lastScanAt < SCAN_INTERVAL_MOVING_MS) return
    this.lastScanAt = now
    // Settled as of this look: whatever it starts says when it lands.
    this.complete = true
    this.completeAt = resolution
    this.completeIdle = idle
    // A picture with nothing before one that is merely too small, each
    // nearest first. Kept apart as they are found rather than sorted on
    // whether a picture is held: asking the entries inside the comparator
    // made that sort the costliest part of a look over hundreds of pages.
    const toReadMissing: Want[] = []
    const toReadLarger: Want[] = []
    /** The nearest pictures each source has to make, nearest first: as
     * many as it may start now. */
    const toDraw = new Map<PictureSourceId, Want[]>()
    const toShrink: Want[] = []
    let farthestHeld: WantedPicture | null = null
    for (const [k, want] of this.wants(resolution)) {
      let entry = this.entries.get(k)
      // Made from something else: not the picture any more.
      if (entry && entry.stamp !== want.stamp) {
        this.forget(k)
        entry = undefined
      }
      if (entry) {
        if (!farthestHeld || want.distance > farthestHeld.distance) {
          farthestHeld = want
        }
        const level = levelFor(want.screen, entry.fullWidth)
        if (entry.level > level) {
          if (!this.shrinking.has(k)) toShrink.push(want)
          continue
        }
        if (entry.level === level) continue
        // Too small for how it is shown now: a larger one is read, and this
        // one stays up until it arrives.
      }
      if (
        this.failed.get(k) === want.stamp ||
        this.reading.has(k) ||
        this.drawing.has(k)
      ) {
        continue
      }
      const group = this.group(want)
      if (!group) continue
      // Its store has not answered yet; it says when it does.
      if (!group.stored) continue
      const stored = group.stored.get(want.key)
      if (stored?.stamp === want.stamp) {
        ;(entry ? toReadLarger : toReadMissing).push(want)
        continue
      }
      if (entry || group.source.canDraw?.(want) === false) continue
      const nearest = toDraw.get(want.source) ?? []
      toDraw.set(want.source, nearest)
      keepNearest(nearest, want, Math.max(1, this.slotsOf(group.source)))
    }

    // Down a level: only once the board is still — a zoom passing through
    // would have them scaled down and read back up again — or to make room.
    const full = this.bytes >= this.budget
    if (toShrink.length > 0 && (full || idle)) {
      for (const want of toShrink) {
        if (this.shrinking.size >= SHRINKS_AT_ONCE) break
        this.shrink(want)
      }
    }

    const byDistance = (a: Want, b: Want) => a.distance - b.distance
    // Up a level, likewise only once the board is still: a zoom passing
    // through would have every picture on screen read again at each level
    // it crosses — hundreds of reads a gesture, each a synchronous trip to
    // the browser to make its `Blob` (up to 12 ms, measured) — while the
    // smaller one shows it meanwhile, a little soft.
    const toRead = [
      ...toReadMissing.sort(byDistance),
      ...(idle ? toReadLarger.sort(byDistance) : []),
    ]
    let nearestDraw: Want | null = null
    for (const [want] of toDraw.values()) {
      if (!nearestDraw || want.distance < nearestDraw.distance) {
        nearestDraw = want
      }
    }
    const nearest =
      nearestDraw && (!toRead[0] || nearestDraw.distance < toRead[0].distance)
        ? nearestDraw
        : (toRead[0] ?? null)
    this.setBusy(toDraw.size > 0 || this.drawing.size > 0)
    if (!nearest) {
      this.withdrawAll()
      return
    }
    // Room is made by bringing pictures down a level first, and only then
    // by letting go of the farthest.
    if (full && (toShrink.length > 0 || this.shrinking.size > 0)) {
      this.withdrawAll()
      return
    }
    // Full: a picture nearer than the farthest one held takes its place —
    // once it can be had now, or a picture would go for nothing.
    if (full && farthestHeld && farthestHeld.distance > nearest.distance) {
      const canTake =
        nearest === nearestDraw
          ? this.canDraw(nearest.source)
          : this.reading.size < READS_AT_ONCE
      if (canTake) this.forget(refKey(farthestHeld))
    }

    /** Sources read back as far as the nearest picture they have to make:
     * nothing of theirs past it is read before it is made. Nothing is read
     * with no room to hold it. */
    const readUpTo = new Set<PictureSourceId>()
    for (const want of toRead) {
      if (this.reading.size >= READS_AT_ONCE) break
      if (this.bytes >= this.budget) break
      if (readUpTo.has(want.source)) continue
      const draw = toDraw.get(want.source)?.[0]
      if (draw && want.distance > draw.distance) {
        readUpTo.add(want.source)
        continue
      }
      this.read(want)
    }

    // Made whether or not there is room to hold it: one made past the
    // budget is kept on the device and read back when it is near enough
    // (`draw`) — what is not made now would be made by nobody.

    for (const source of this.sources.values()) {
      const wants = toDraw.get(source.id)
      if (!wants || !this.canDraw(source.id)) {
        source.turn.withdraw()
        continue
      }
      for (const want of wants) {
        if (!this.canDraw(source.id)) break
        if (!source.turn.begin(want, this.wake)) break
        const k = refKey(want)
        this.drawing.set(k, source.id)
        void this.draw(source, want).finally(() => {
          this.drawing.delete(k)
          this.complete = false
          source.turn.end()
        })
      }
    }
  }

  /** Lets go of the pictures the board no longer shows — a spread folded
   * away, a card read on, a file closed or deleted. The device keeps them.
   * Called whenever the board changes. */
  retain(): void {
    // The pictures wanted, or where they are, may have changed.
    this.complete = false
    const keys = new Set<string>()
    const groups = new Set<string>()
    for (const wanted of this.deps.wanted()) {
      keys.add(refKey(wanted))
      groups.add(groupKey(wanted.source, wanted.group))
    }
    for (const k of [...this.groups.keys()]) {
      if (!groups.has(k)) this.dropGroup(k)
    }
    for (const k of [...this.entries.keys()]) {
      if (!keys.has(k)) this.forget(k)
    }
  }

  /** What is wanted, or what can be made of it, may have changed without
   * the board changing: looked over again on the next pump. */
  invalidate(): void {
    this.complete = false
  }

  /** The file at `path` was modified, renamed or deleted: what is held of
   * it, of any source, is of the old file — where its version says so. A
   * group named by a file without being a picture of it (a board's cards,
   * which the board saves its camera into) stays: each of its pictures
   * says by its stamp whether it is still right. */
  fileChanged(path: string): void {
    for (const [id, source] of this.sources) {
      const k = groupKey(id, path)
      const group = this.groups.get(k)
      if (group && source.version(path) !== group.version) this.dropGroup(k)
    }
  }

  destroy(): void {
    this.destroyed = true
    this.setBusy(false)
    this.withdrawAll()
    for (const k of [...this.groups.keys()]) this.dropGroup(k)
    for (const entry of this.entries.values()) this.close(entry)
    this.entries.clear()
    this.bytes = 0
  }

  /** Every picture wanted, once, with how many device pixels wide it is
   * shown now. One picture can be shown in several places — an image file
   * on two cards, a PDF page in a folded card and in its spread — and is as
   * near as the nearest of them and as wide as the widest. Taken place by
   * place, it was let go of as far for one and read back as near for the
   * other, every frame. */
  private wants(resolution: number): Map<string, Want> {
    const wants = new Map<string, Want>()
    for (const wanted of this.deps.wanted()) {
      const k = refKey(wanted)
      const known = wants.get(k)
      if (!known) {
        wants.set(k, { ...wanted, screen: wanted.width * resolution })
        continue
      }
      const width = Math.max(known.width, wanted.width)
      wants.set(k, {
        ...known,
        width,
        distance: Math.min(known.distance, wanted.distance),
        screen: width * resolution,
      })
    }
    return wants
  }

  private setBusy(busy: boolean): void {
    if (busy === this.busy) return
    this.busy = busy
    this.deps.onBusy?.(busy)
  }

  private canDraw(source: PictureSourceId): boolean {
    const known = this.sources.get(source)
    return !!known && this.slotsOf(known) > 0 && this.deps.idle()
  }

  /** How many more pictures `source` may start now. */
  private slotsOf(source: PictureSource): number {
    let making = 0
    for (const id of this.drawing.values()) if (id === source.id) making += 1
    return (source.concurrency ?? 1) - making
  }

  private withdrawAll(): void {
    for (const source of this.sources.values()) source.turn.withdraw()
  }

  /** The state of a group whose pictures are wanted, asking its store what
   * it has of it on first sight. */
  private group(ref: PictureRef): GroupState | null {
    const k = groupKey(ref.source, ref.group)
    const known = this.groups.get(k)
    if (known) return known
    const source = this.sources.get(ref.source)
    if (!source) return null
    const version = source.version(ref.group)
    if (version === null) return null
    const state: GroupState = {
      source,
      group: ref.group,
      version,
      stored: null,
      metas: new Map(),
    }
    this.groups.set(k, state)
    void source.store.entries(ref.group, version).then(
      (entries) => {
        if (this.groups.get(k) !== state) return
        this.complete = false
        state.stored = new Map(entries)
        for (const [key, stored] of entries) {
          if (stored.meta !== null) state.metas.set(key, stored.meta)
        }
      },
      (error: unknown) => {
        this.deps.reportError(`${source.label} entries`, error)
        if (this.groups.get(k) !== state) return
        this.complete = false
        state.stored = new Map()
      },
    )
    return state
  }

  private read(want: Want): void {
    const gk = groupKey(want.source, want.group)
    const group = this.groups.get(gk)
    const stored = group?.stored?.get(want.key)
    if (!group || !stored) return
    const k = refKey(want)
    const level = levelFor(want.screen, stored.width)
    this.reading.add(k)
    void (async () => {
      const data = await group.source.store.read(
        group.group,
        group.version,
        want.key,
      )
      if (this.groups.get(gk) !== group) return
      if (!data) {
        // Gone from the device after all: made instead.
        group.stored?.delete(want.key)
        return
      }
      const win = this.deps.doc.defaultView
      if (!win) return
      const bitmap = await win.createImageBitmap(
        new Blob([data]),
        resizedTo(level, stored.width),
      )
      if (this.destroyed || this.groups.get(gk) !== group) {
        bitmap.close()
        return
      }
      this.hold(k, {
        bitmap,
        level,
        fullWidth: stored.width,
        stamp: stored.stamp,
      })
      this.deps.onChange(want.source, want.group, want.key)
    })()
      .catch((error: unknown) => {
        if (this.groups.get(gk) !== group) return
        // An unreadable image is made again, over it.
        this.deps.reportError(`${group.source.label} read`, error)
        group.stored?.delete(want.key)
      })
      .finally(() => {
        this.reading.delete(k)
        this.complete = false
      })
  }

  private async draw(source: PictureSource, want: Want): Promise<void> {
    const gk = groupKey(want.source, want.group)
    const group = this.groups.get(gk)
    if (!group) return
    const k = refKey(want)
    let drawn: DrawnPicture | 'unavailable' | null = null
    try {
      drawn = await source.draw(want, group.version)
      if (this.destroyed || this.groups.get(gk) !== group) return
      if (drawn === null) return
      if (drawn === 'unavailable') {
        this.failed.set(k, want.stamp)
        return
      }
      const { canvas, meta } = drawn
      const win = this.deps.doc.defaultView
      if (!win) return
      if (source.settle && !(await source.settle())) return
      if (this.destroyed || this.groups.get(gk) !== group) return
      const fullWidth = canvas.width
      const level = levelFor(want.screen, fullWidth)
      // Past the budget it is only kept, not held: the scan reads it back
      // once it is nearer than the farthest held.
      const held = this.bytes < this.budget
      const [bitmap, encoded] = await Promise.all([
        held
          ? win.createImageBitmap(canvas, resizedTo(level, fullWidth))
          : null,
        encode(canvas),
      ])
      if (this.destroyed || this.groups.get(gk) !== group) {
        bitmap?.close()
        return
      }
      if (bitmap) this.hold(k, { bitmap, level, fullWidth, stamp: want.stamp })
      if (meta !== null) group.metas.set(want.key, meta)
      if (encoded) {
        const picture: StoredPicture = {
          width: fullWidth,
          height: canvas.height,
          stamp: want.stamp,
          meta,
        }
        source.store.write(
          group.group,
          group.version,
          want.key,
          await encoded.arrayBuffer(),
          picture,
        )
        group.stored?.set(want.key, picture)
      }
      if (bitmap) this.deps.onChange(want.source, want.group, want.key)
    } catch (error) {
      // A group dropped meanwhile was closed under the draw: not a failure.
      if (this.groups.get(gk) !== group) return
      this.deps.reportError(source.label, error)
      this.failed.set(k, want.stamp)
    } finally {
      if (drawn !== null && drawn !== 'unavailable') {
        drawn.canvas.width = 0
        drawn.canvas.height = 0
      }
    }
  }

  /** Brings a picture held larger than it is shown down to the level that
   * covers it, from the picture already held. */
  private shrink(want: Want): void {
    const k = refKey(want)
    const entry = this.entries.get(k)
    const win = this.deps.doc.defaultView
    if (!entry || !win) return
    const level = levelFor(want.screen, entry.fullWidth)
    this.shrinking.add(k)
    void win
      .createImageBitmap(entry.bitmap, resizedTo(level, entry.fullWidth))
      .then(
        (bitmap) => {
          // Let go of, or replaced, meanwhile.
          if (this.destroyed || this.entries.get(k) !== entry) {
            bitmap.close()
            return
          }
          this.hold(k, {
            bitmap,
            level,
            fullWidth: entry.fullWidth,
            stamp: entry.stamp,
          })
        },
        (error: unknown) => {
          if (this.entries.get(k) === entry) {
            this.deps.reportError(
              `${this.sources.get(want.source)?.label ?? want.source} shrink`,
              error,
            )
          }
        },
      )
      .finally(() => {
        this.shrinking.delete(k)
        this.complete = false
      })
  }

  private hold(k: string, entry: Omit<Entry, 'dark'>): void {
    this.forget(k)
    this.entries.set(k, { ...entry, dark: null })
    this.bytes += bitmapBytes(entry.bitmap)
  }

  private dropGroup(gk: string): void {
    this.complete = false
    const group = this.groups.get(gk)
    this.groups.delete(gk)
    if (group) group.source.release?.(group.group)
    const prefix = `${gk}\u0000`
    for (const k of [...this.entries.keys()]) {
      if (k.startsWith(prefix)) this.forget(k)
    }
    for (const k of [...this.failed.keys()]) {
      if (k.startsWith(prefix)) this.failed.delete(k)
    }
    if (group && !this.destroyed) {
      this.deps.onChange(group.source.id, group.group, null)
    }
  }

  private forget(k: string): void {
    const entry = this.entries.get(k)
    if (!entry) return
    // Room made, or a picture to have again: worth another look.
    this.complete = false
    this.entries.delete(k)
    this.bytes -= bitmapBytes(entry.bitmap)
    if (entry.dark) this.bytes -= bitmapBytes(entry.dark)
    this.close(entry)
  }

  private close(entry: Entry): void {
    entry.bitmap.close()
    entry.dark?.close()
  }

  /** The picture through `filter` — the one the stylesheet puts on the
   * thing it stands for in a dark theme — baked once. */
  private filtered(bitmap: ImageBitmap, filter: string): ImageBitmap | null {
    const win = this.deps.doc.defaultView
    if (!win || typeof win.OffscreenCanvas !== 'function') return null
    const canvas = new win.OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.filter = filter
    ctx.drawImage(bitmap, 0, 0)
    return canvas.transferToImageBitmap()
  }
}

/** Puts `want` among `nearest`, kept sorted nearest first and at most `n`
 * long. */
function keepNearest(nearest: Want[], want: Want, n: number): void {
  let at = nearest.length
  while (at > 0 && nearest[at - 1].distance > want.distance) at -= 1
  if (at >= n) return
  nearest.splice(at, 0, want)
  if (nearest.length > n) nearest.pop()
}

/** Which of `LEVELS` covers a picture `fullWidth` pixels wide, shown
 * `screen` device pixels wide. */
export function levelFor(screen: number, fullWidth: number): number {
  return LEVELS.find((level) => level * fullWidth >= screen) ?? 1
}

/** Decoding options for a picture at `level` of `fullWidth`: whole is
 * decoded as it is. */
export function resizedTo(
  level: number,
  fullWidth: number,
): ImageBitmapOptions | undefined {
  return level < 1
    ? {
        resizeWidth: Math.max(1, Math.round(level * fullWidth)),
        resizeQuality: 'medium',
      }
    : undefined
}

const bitmapBytes = (bitmap: ImageBitmap): number =>
  bitmap.width * bitmap.height * 4

function encode(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) =>
    canvas.toBlob(resolve, ENCODING, ENCODING_QUALITY),
  )
}
