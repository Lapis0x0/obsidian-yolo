// Where a node is shown while it moves, as a function of time — the
// arithmetic of ./canvas/motions.ts, which every part of the board that
// shows a node asks (the DOM, the overview canvas, the GPU scene, the edges).
//
// A node is shown at a pose: a rectangle in world units and an opacity — and,
// picked up (`liftedPose`), turned about its centre and casting a shadow. A
// card's pose is its own box scaled about its top-left — its content is laid
// out at its own size and shown that much smaller or larger; a group's is its
// frame, whatever shape. A tween takes a pose to another over a duration, on
// a curve; a tween asked for while another is under way starts from where
// that one has the node now, so the motion carries on rather than jumping.
//
// Pure: no DOM, no clock of its own — the caller says what time it is.

/** A node as it is shown: where, how big, how opaque. World units. */
export type Pose = Readonly<{
  x: number
  y: number
  w: number
  h: number
  opacity: number
  /** Turned this far about its centre, in radians; not at all if absent. */
  rotate?: number
  /** How far it is picked up, 0 to 1 — what its shadow shows; at rest on
   * the board if absent. */
  lift?: number
}>

/** A timing curve, as CSS writes it and as a function of progress. */
export type Ease = Readonly<{ css: string; at: (t: number) => number }>

/**
 * `cubic-bezier(x1, y1, x2, y2)`, sampled the way a browser does — the
 * curve's x solved for by Newton's method, falling back to bisection — so a
 * pose sampled here is the pose the same Web Animation shows at that moment.
 */
export function cubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Ease {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const x = (s: number) => ((ax * s + bx) * s + cx) * s
  const y = (s: number) => ((ay * s + by) * s + cy) * s
  const dx = (s: number) => (3 * ax * s + 2 * bx) * s + cx
  const solve = (t: number): number => {
    let s = t
    for (let i = 0; i < 8; i += 1) {
      const error = x(s) - t
      if (Math.abs(error) < 1e-6) return s
      const slope = dx(s)
      if (Math.abs(slope) < 1e-6) break
      s -= error / slope
    }
    let lo = 0
    let hi = 1
    s = t
    while (hi - lo > 1e-6) {
      if (x(s) < t) lo = s
      else hi = s
      s = (lo + hi) / 2
    }
    return s
  }
  return {
    css: `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})`,
    at: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : y(solve(t))),
  }
}

/** One pose going to another. `start` and the rest in ms of the caller's
 * clock; nothing moves for `delay` after `start`. */
export type Tween = Readonly<{
  from: Pose
  to: Pose
  start: number
  delay: number
  duration: number
  ease: Ease
}>

/** How far `tween` has come at `now`, 0 to 1, before the curve. */
export function progressAt(tween: Tween, now: number): number {
  if (tween.duration <= 0) return now >= tween.start + tween.delay ? 1 : 0
  return Math.min(
    1,
    Math.max(0, (now - tween.start - tween.delay) / tween.duration),
  )
}

/** Whether `tween` has arrived by `now`. */
export function arrived(tween: Tween, now: number): boolean {
  return progressAt(tween, now) >= 1
}

/** Where `tween` shows its node at `now`. */
export function poseAt(tween: Tween, now: number): Pose {
  const k = tween.ease.at(progressAt(tween, now))
  const mix = (a: number, b: number) => a + (b - a) * k
  const { from, to } = tween
  return {
    x: mix(from.x, to.x),
    y: mix(from.y, to.y),
    w: mix(from.w, to.w),
    h: mix(from.h, to.h),
    opacity: mix(from.opacity, to.opacity),
    ...(from.rotate !== undefined || to.rotate !== undefined
      ? { rotate: mix(from.rotate ?? 0, to.rotate ?? 0) }
      : {}),
    ...(from.lift !== undefined || to.lift !== undefined
      ? { lift: mix(from.lift ?? 0, to.lift ?? 0) }
      : {}),
  }
}

/** A rectangle shown as it is, whole. */
export function poseOf(
  rect: Readonly<{ x: number; y: number; w: number; h: number }>,
  opacity = 1,
): Pose {
  return { x: rect.x, y: rect.y, w: rect.w, h: rect.h, opacity }
}

/** The same pose, near enough that no one could see the difference. */
export function samePose(a: Pose, b: Pose): boolean {
  const near = (p: number, q: number) => Math.abs(p - q) < 0.01
  return (
    near(a.x, b.x) &&
    near(a.y, b.y) &&
    near(a.w, b.w) &&
    near(a.h, b.h) &&
    near(a.opacity, b.opacity) &&
    Math.abs((a.rotate ?? 0) - (b.rotate ?? 0)) < 1e-4 &&
    near(a.lift ?? 0, b.lift ?? 0)
  )
}

/** A card `rect` shown `scale` times its size from the same centre, at
 * `opacity` — how a card arrives (`NODE_ENTER_FROM_SCALE`). */
export function scaledAboutCentre(
  rect: Readonly<{ x: number; y: number; w: number; h: number }>,
  scale: number,
  opacity: number,
): Pose {
  return {
    x: rect.x + (rect.w * (1 - scale)) / 2,
    y: rect.y + (rect.h * (1 - scale)) / 2,
    w: rect.w * scale,
    h: rect.h * scale,
    opacity,
  }
}

/** How a carried thing is picked up (`liftedPose`). */
export type Lift = Readonly<{
  /** The middle of all it carries as the drag began, world units. */
  centre: Readonly<{ x: number; y: number }>
  /** Shown this many times its size, fully picked up. */
  scale: number
  /** And turned this far about the centre, in radians. */
  rotate: number
}>

/**
 * Where a node carried by a drag is shown, `amount` (0 to 1) of the way to
 * picked up: grown by `lift.scale` and turned by `lift.rotate` about the
 * middle of everything the drag carries, so what it carries is picked up as
 * one thing. `home` is where the node was as the drag began, `live` where the
 * drag has it now — a drag carries everything the same way, so the middle
 * goes with each node.
 */
export function liftedPose(
  home: Readonly<{ x: number; y: number }>,
  live: Readonly<{ x: number; y: number; w: number; h: number }>,
  lift: Lift,
  amount: number,
): Pose {
  const scale = 1 + (lift.scale - 1) * amount
  const centre = {
    x: lift.centre.x + live.x - home.x,
    y: lift.centre.y + live.y - home.y,
  }
  const x = centre.x + (live.x - centre.x) * scale
  const y = centre.y + (live.y - centre.y) * scale
  const w = live.w * scale
  const h = live.h * scale
  const rotate = lift.rotate * amount
  if (rotate === 0) return { x, y, w, h, opacity: 1, lift: amount }
  // Turned about the middle of what is carried, which for one card is its
  // own centre: its centre goes round that point, and it turns about it.
  const cos = Math.cos(rotate)
  const sin = Math.sin(rotate)
  const dx = x + w / 2 - centre.x
  const dy = y + h / 2 - centre.y
  return {
    x: centre.x + dx * cos - dy * sin - w / 2,
    y: centre.y + dx * sin + dy * cos - h / 2,
    w,
    h,
    opacity: 1,
    rotate,
    lift: amount,
  }
}
