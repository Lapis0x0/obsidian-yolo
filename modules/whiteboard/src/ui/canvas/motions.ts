// Where every node in motion is shown, for everything that shows one.
//
// The board says where each node is. Between one place and the next — a
// group folding into its box, a spread dealt out of its card, an arrangement,
// a card arriving, a frame reaching out for a card about to join it — a node
// is shown somewhere else for a moment, and that moment is kept here, once:
// a tween from one pose to another (../tween.ts), by node.
//
// The board is shown by several hands at once — a card's element where it
// has one, and where it has none (most cards, most of the time) the overview
// canvas's drawing and the GPU scene's text over it; the edges are drawn to
// wherever their cards are. Each asks here where a node is shown
// (`pose`), so a moving card moves the same in all of them, whichever is
// drawing it, and its edges go with it. An element is moved by a Web
// Animation that plays the same tween on the compositor (`play`) — put on it
// when the tween starts, or when the element mounts partway through
// (`attach`), at the point the tween has reached.
//
// A tween asked for while one is under way starts from where that one has
// the node now (`move`), so a frame told a new size every pointer move glides
// after the pointer instead of jumping. One that ends where the board has
// the node is let go of (`tick`): the node is just shown where it is. One
// told to hold (`hold`) stays where it ended until it is moved again, or its
// node leaves the board — a node gathered into a fold, waiting for the fold
// to close over it.
//
// A node can also be shown on its way out after it has left the board
// (`depart`): a card dropped on a collapsed group, going into its cell. The
// board no longer has it, so what it was is kept with its motion, for the
// canvas to draw (`departures`) until it gets there.

import type { BoardNode, NodeId } from '../../domain/fileFormat'
import type { CardRect } from '../../domain/resize'
import { ARRANGE_ANIMATION_MS } from '../constants'
import {
  type Ease,
  type Pose,
  type Tween,
  arrived,
  cubicBezier,
  poseAt,
  poseOf,
  samePose,
} from '../tween'

import { nodeElementScale } from './cardContent'

/** ARRANGE_ANIMATION_EASING (../constants.ts), as a curve. */
export const ARRANGE_EASE: Ease = cubicBezier(0.22, 1, 0.36, 1)

type Entry = {
  tween: Tween
  hold: boolean
  /** Drawn over the other nodes moving with it. */
  onTop: boolean
  /** A group's frame changing shape, rather than a node carried whole. */
  reshape: boolean
  /** The Web Animation showing it on its element, while it has one. */
  animation: Animation | null
}

export type MotionsDeps = Readonly<{
  /** The window whose clock and preferences the board goes by. */
  window: () => Window
  /** Where the board has a node; null once it has left the board. */
  rectOf: (id: NodeId) => CardRect | null
  /** A node's element, while it is shown by one. */
  elementOf: (id: NodeId) => HTMLElement | null
  /** A group's world units per unit of its element (canvas.ts's
   * `scaleOf`). */
  scaleOf: (id: NodeId) => number
}>

export type MoveOptions = Readonly<{
  /** Where it starts from; where it is shown now by default. */
  from?: Pose
  delay?: number
  /** Stays at `to` until moved again — let go of only if that is where the
   * board comes to have it. Otherwise `to` is where the board has it, and
   * the motion follows the board there (`tick`). */
  hold?: boolean
  onTop?: boolean
  /**
   * A group's frame taking another shape — reaching out for a card about to
   * join it, closing onto its box — shown by its box itself rather than
   * scaled: scaling a frame would stretch its rounded corners, its border
   * and its title bar with it. Anything else is carried whole, scaled from
   * its top-left — a group too, put away into a box with the rest.
   */
  reshape?: boolean
}>

export class Motions {
  private readonly entries = new Map<NodeId, Entry>()
  private query: Readonly<{ window: Window; list: MediaQueryList }> | null =
    null
  private readonly departing = new Map<
    NodeId,
    Readonly<{ node: BoardNode; tween: Tween }>
  >()

  constructor(private readonly deps: MotionsDeps) {}

  private now(): number {
    return this.deps.window().performance.now()
  }

  private reducedMotion(): boolean {
    // A JS-driven animation: the reduced-motion degrade is ours to make
    // (CLAUDE.md) — the global CSS fallback does not reach Web Animations.
    // Asked once per window: a fold asks it for every node it moves.
    const win = this.deps.window()
    if (this.query?.window !== win) {
      this.query = {
        window: win,
        list: win.matchMedia('(prefers-reduced-motion: reduce)'),
      }
    }
    return this.query.list.matches
  }

  /** Shows `id` going to `to`. Under reduced motion it is there at once. */
  move(id: NodeId, to: Pose, options: MoveOptions = {}): void {
    const now = this.now()
    const from = options.from ?? this.pose(id) ?? this.homePose(id)
    if (!from) return
    const instant = this.reducedMotion()
    const previous = this.entries.get(id)
    previous?.animation?.cancel()
    const entry: Entry = {
      tween: {
        from,
        to,
        start: now,
        delay: instant ? 0 : (options.delay ?? 0),
        duration: instant ? 0 : ARRANGE_ANIMATION_MS,
        ease: ARRANGE_EASE,
      },
      hold: options.hold ?? false,
      onTop: options.onTop ?? false,
      reshape: options.reshape ?? false,
      animation: null,
    }
    this.entries.set(id, entry)
    this.play(id, entry)
  }

  /** Shows `id` going to where the board has it, and lets go of it there. */
  settle(id: NodeId, options: Omit<MoveOptions, 'hold'> = {}): void {
    const home = this.homePose(id)
    if (!home) return
    if (this.reducedMotion()) {
      this.stop([id])
      return
    }
    this.move(id, home, options)
  }

  /** Shows `id` going to `rect` and holding there — unless it is already on
   * its way there, which a gesture asking every pointer move would
   * otherwise restart. */
  follow(id: NodeId, rect: CardRect): void {
    const to = poseOf(rect)
    const entry = this.entries.get(id)
    if (entry?.hold && samePose(entry.tween.to, to)) return
    if (!entry) {
      const home = this.homePose(id)
      if (home && samePose(home, to)) return
    }
    this.move(id, to, { hold: true, reshape: true })
  }

  /** Where `id` is shown now; null when it is shown where the board has
   * it. */
  pose(id: NodeId): Pose | null {
    const entry = this.entries.get(id)
    return entry ? poseAt(entry.tween, this.now()) : null
  }

  /** Every node shown somewhere the board does not have it, the ones drawn
   * on top last. */
  *moving(): Iterable<Readonly<{ id: NodeId; pose: Pose }>> {
    const now = this.now()
    const top: NodeId[] = []
    for (const [id, entry] of this.entries) {
      if (entry.onTop) top.push(id)
      else yield { id, pose: poseAt(entry.tween, now) }
    }
    for (const id of top) {
      const entry = this.entries.get(id)
      if (entry) yield { id, pose: poseAt(entry.tween, now) }
    }
  }

  get size(): number {
    return this.entries.size + this.departing.size
  }

  /** Shows `node`, which has just left the board, going from `from` to `to`
   * — and then gone. Not at all under reduced motion. */
  depart(node: BoardNode, from: Pose, to: Pose): void {
    if (this.reducedMotion()) return
    this.departing.set(node.id, {
      node,
      tween: {
        from,
        to,
        start: this.now(),
        delay: 0,
        duration: ARRANGE_ANIMATION_MS,
        ease: ARRANGE_EASE,
      },
    })
  }

  /** Whether `id` has left the board and is still on its way out. */
  isDeparting(id: NodeId): boolean {
    return this.departing.has(id)
  }

  /** The nodes on their way out (`depart`), each where it is shown now. */
  *departures(): Iterable<Readonly<{ node: BoardNode; pose: Pose }>> {
    const now = this.now()
    for (const { node, tween } of this.departing.values()) {
      yield { node, pose: poseAt(tween, now) }
    }
  }

  /** `id`'s element has just mounted: shown where its tween has it, from
   * here on by its own Web Animation. Whether it is in motion. */
  attach(id: NodeId): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    this.play(id, entry)
    return true
  }

  /** Shows these where the board has them, at once. */
  stop(ids: Iterable<NodeId>): void {
    for (const id of ids) {
      this.entries.get(id)?.animation?.cancel()
      this.entries.delete(id)
    }
  }

  /** Resolves once every one of `ids` has got where it is going. */
  arrived(ids: Iterable<NodeId>): Promise<void> {
    let end = this.now()
    for (const id of ids) {
      const tween = this.entries.get(id)?.tween
      if (tween) end = Math.max(end, tween.start + tween.delay + tween.duration)
    }
    const wait = end - this.now()
    if (wait <= 0) return Promise.resolve()
    return new Promise((resolve) =>
      this.deps.window().setTimeout(resolve, wait),
    )
  }

  /**
   * Once a frame: lets go of every node that has got where the board has
   * it, and of every node that has left the board — its element, if it is
   * still being let go of (cardRenderer.ts's `playExit`), keeps the pose it
   * was left in. A node on its way to where the board had it, when the
   * board has since put it somewhere else, goes on from where it is to
   * there instead. The nodes still moving, for whoever draws them to draw
   * again; those let go of are among them, to be drawn where they rest.
   */
  tick(): ReadonlySet<NodeId> {
    const now = this.now()
    const changed = new Set<NodeId>()
    for (const [id, { tween }] of this.departing) {
      if (arrived(tween, now)) this.departing.delete(id)
      changed.add(id)
    }
    for (const [id, entry] of this.entries) {
      const home = this.homePose(id)
      if (!home) {
        this.entries.delete(id)
        changed.add(id)
        continue
      }
      if (!entry.hold && !samePose(entry.tween.to, home)) {
        this.move(id, home, { onTop: entry.onTop, reshape: entry.reshape })
        changed.add(id)
        continue
      }
      if (!arrived(entry.tween, now)) {
        changed.add(id)
        continue
      }
      if (entry.hold && !samePose(entry.tween.to, home)) continue
      entry.animation?.cancel()
      this.entries.delete(id)
      changed.add(id)
    }
    return changed
  }

  /** The CSS transform `id`'s element is held at, from its own top-left
   * corner — for a copy of it standing in its place. */
  transformOf(id: NodeId): string | null {
    const el = this.deps.elementOf(id)
    const pose = this.pose(id)
    const base = this.deps.rectOf(id)
    if (!el || !pose || !base) return null
    return cardTransform(el, pose, base)
  }

  destroy(): void {
    this.stop([...this.entries.keys()])
    this.departing.clear()
  }

  private homePose(id: NodeId): Pose | null {
    const rect = this.deps.rectOf(id)
    return rect ? poseOf(rect) : null
  }

  /** `entry` on `id`'s element, if it has one, at the point its tween has
   * reached: a card by its transform (and opacity), from where its element
   * stands; a frame by its box. */
  private play(id: NodeId, entry: Entry): void {
    entry.animation?.cancel()
    entry.animation = null
    const el = this.deps.elementOf(id)
    if (!el) return
    const { from, to } = entry.tween
    const fades = from.opacity !== 1 || to.opacity !== 1
    let keyframes: Keyframe[]
    if (entry.reshape) {
      // Layout properties, animated on purpose (CLAUDE.md asks for transform
      // and opacity): a frame is a rounded, bordered wash, and scaling one
      // stretches its corners and its border with it. One element per group,
      // out of the flow, holding nothing that lays itself out against its
      // size (group.css's `contain: layout`): a frame of layout is a frame
      // of one box.
      const scale = this.deps.scaleOf(id)
      const at = (pose: Pose): Keyframe => ({
        left: `${pose.x}px`,
        top: `${pose.y}px`,
        width: `${pose.w / scale}px`,
        height: `${pose.h / scale}px`,
        ...(fades ? { opacity: pose.opacity } : {}),
      })
      keyframes = [at(from), at(to)]
    } else {
      const base = this.deps.rectOf(id)
      if (!base) return
      const at = (pose: Pose): Keyframe => ({
        transformOrigin: '0 0',
        transform: cardTransform(el, pose, base),
        ...(fades ? { opacity: pose.opacity } : {}),
        ...(entry.onTop ? { zIndex: 1 } : {}),
      })
      keyframes = [at(from), at(to)]
    }
    const { tween } = entry
    const animation = el.animate(keyframes, {
      duration: tween.duration,
      delay: tween.delay,
      easing: tween.ease.css,
      fill: 'both',
    })
    animation.currentTime = Math.max(0, this.now() - tween.start)
    entry.animation = animation
  }
}

/** The transform that shows a card whose element stands at `base` at
 * `pose`, in the element's own units (`nodeElementScale`). */
function cardTransform(el: HTMLElement, pose: Pose, base: CardRect): string {
  const unit = nodeElementScale(el)
  const dx = (pose.x - base.x) / unit
  const dy = (pose.y - base.y) / unit
  const scale = base.w > 0 ? pose.w / base.w : 1
  return `translate(${dx}px, ${dy}px) scale(${scale})`
}
