import { WHEEL_PAN_GLIDE_TAU_MS } from './constants'

/**
 * A wheel scroll inside a card, eased the way the board's own wheel pan is
 * (cameraController.ts's `panByWheel`): each event moves a *target*, and the
 * element approaches it over the next few frames. Written straight from the
 * event, a mouse notch jumps a whole step in one frame and a 120Hz display
 * shows one moving frame per event — the card would scroll in a way the board
 * around it does not.
 *
 * The target is clamped to the element's scroll range, so a spin past the end
 * does not bank distance to be paid back later. Whoever else writes the
 * scroll position (a jump to a page, a search reveal) wins: a glide that finds
 * the element somewhere it did not put it stops there.
 */
type Glide = {
  targetTop: number
  targetLeft: number
  /** Where the glide is, unrounded — the browser may store less precision
   * than a frame's step, and progress kept in the element would stall. */
  top: number
  left: number
  /** What the element read back after the last write: anything else means
   * someone else moved it. */
  seenTop: number
  seenLeft: number
  lastTime: number
  frame: number
}

const glides = new WeakMap<HTMLElement, Glide>()

export function glideScrollBy(
  el: HTMLElement,
  deltaX: number,
  deltaY: number,
): void {
  const win = el.ownerDocument.defaultView
  const maxTop = Math.max(0, el.scrollHeight - el.clientHeight)
  const maxLeft = Math.max(0, el.scrollWidth - el.clientWidth)
  const clamp = (value: number, max: number) =>
    Math.max(0, Math.min(max, value))

  if (!win || win.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.scrollTop = clamp(el.scrollTop + deltaY, maxTop)
    el.scrollLeft = clamp(el.scrollLeft + deltaX, maxLeft)
    return
  }

  const running = glides.get(el)
  if (running && isWhereLeft(el, running)) {
    running.targetTop = clamp(running.targetTop + deltaY, maxTop)
    running.targetLeft = clamp(running.targetLeft + deltaX, maxLeft)
    return
  }
  if (running) win.cancelAnimationFrame(running.frame)

  const glide: Glide = {
    targetTop: clamp(el.scrollTop + deltaY, maxTop),
    targetLeft: clamp(el.scrollLeft + deltaX, maxLeft),
    top: el.scrollTop,
    left: el.scrollLeft,
    seenTop: el.scrollTop,
    seenLeft: el.scrollLeft,
    lastTime: win.performance.now(),
    frame: 0,
  }
  const step = (now: number) => {
    if (!el.isConnected || !isWhereLeft(el, glide)) {
      glides.delete(el)
      return
    }
    const dt = Math.max(0, now - glide.lastTime)
    glide.lastTime = now
    const k = 1 - Math.exp(-dt / WHEEL_PAN_GLIDE_TAU_MS)
    glide.top += (glide.targetTop - glide.top) * k
    glide.left += (glide.targetLeft - glide.left) * k
    const done =
      Math.abs(glide.targetTop - glide.top) < 0.5 &&
      Math.abs(glide.targetLeft - glide.left) < 0.5
    if (done) {
      glide.top = glide.targetTop
      glide.left = glide.targetLeft
    }
    el.scrollTop = glide.top
    el.scrollLeft = glide.left
    glide.seenTop = el.scrollTop
    glide.seenLeft = el.scrollLeft
    if (done) {
      glides.delete(el)
      return
    }
    glide.frame = win.requestAnimationFrame(step)
  }
  glide.frame = win.requestAnimationFrame(step)
  glides.set(el, glide)
}

function isWhereLeft(el: HTMLElement, glide: Glide): boolean {
  return (
    Math.abs(el.scrollTop - glide.seenTop) < 1 &&
    Math.abs(el.scrollLeft - glide.seenLeft) < 1
  )
}
