/**
 * Decides when scrolling near an edge of the rendered history window should
 * load more turns.
 *
 * The rule is deliberately *not* derived from scroll position: `scrollTop`
 * has several producers — the reader, the scroll controller's anchor
 * compensation, content reflowing as markdown and LaTeX lay out a second
 * time, and the window itself being replaced — and every attempt to tell them
 * apart after the fact by comparing successive positions misreads at least one
 * of them. Reading the direction off the input event instead means the
 * question "did the reader ask for more?" is answered by the only thing that
 * can actually answer it.
 *
 * That leaves no cross-event state to keep, so there is nothing to reset when
 * the window changes, nothing to re-arm, and nothing that can be left disarmed
 * in a coordinate system that no longer exists. Rate limiting falls out of the
 * scroll controller instead: a load's anchor compensation settles for up to
 * `SETTLEMENT_TIMEOUT_MS`, and no further load fires until it has. A reader who
 * keeps pushing in the same direction — including while pinned against an edge
 * that cannot scroll any further, where the browser reports no scrolling at
 * all — keeps producing input events, so they page again as soon as the
 * previous load settles.
 *
 * Keyboard scrolling is deliberately not one of these inputs. Its listener
 * would have to live on the scroller, so it only ever sees keys that reached a
 * focused element inside it — in a chat timeline, a message's own button,
 * branch tab or editor. There Space activates the control, Home/End move
 * within a composite widget, and arrows are often the widget's own navigation,
 * so reading any of them as "load more" fires on input that was never about
 * the conversation's scroll position. With focus anywhere else — the composer,
 * the workspace — the listener never runs at all. The path is therefore either
 * wrong or dead, and a reader who arrives at an edge by any means can page
 * with a single wheel notch.
 */

/** Which end of the rendered window the reader is asking to extend. */
export type PagingDirection = 'earlier' | 'newer'

/**
 * Wheel and trackpad. Negative `deltaY` is toward the top of the document,
 * which is where earlier turns live.
 */
export const getWheelPagingDirection = (
  deltaY: number,
): PagingDirection | null => {
  if (deltaY < 0) {
    return 'earlier'
  }
  return deltaY > 0 ? 'newer' : null
}

/**
 * Touch drag on the content. The content follows the finger, so a finger
 * moving *down* the screen pulls earlier turns into view.
 */
export const getTouchPagingDirection = (
  previousClientY: number,
  currentClientY: number,
): PagingDirection | null => {
  if (currentClientY > previousClientY) {
    return 'earlier'
  }
  return currentClientY < previousClientY ? 'newer' : null
}

/**
 * Scrollbar drag. Unlike wheel and touch this has no delta of its own, so the
 * direction comes from the resulting scroll position — which is unambiguous
 * here precisely because the caller only consults it while a pointer is held
 * down on the scroller, i.e. while the reader is the one moving it.
 */
export const getScrollPagingDirection = (
  previousScrollTop: number,
  currentScrollTop: number,
): PagingDirection | null => {
  if (currentScrollTop < previousScrollTop) {
    return 'earlier'
  }
  return currentScrollTop > previousScrollTop ? 'newer' : null
}

export type PagingRequest = {
  /** What the reader's input asked for. */
  direction: PagingDirection
  /** Current distance from the viewport to each edge of the rendered window. */
  distanceToTop: number
  distanceToBottom: number
  /** How close to an edge counts as asking for more. */
  threshold: number
  hasEarlierMessages: boolean
  hasNewerMessages: boolean
  /**
   * True while a load already fired has not taken effect yet, or while the
   * scroll controller is still correcting scroll position for a previous load
   * or an explicit jump. This is the entire rate limit, and both of its
   * sources clear themselves: the controller's settlement is bounded by its
   * timeout, and a load stops being in flight as soon as the window it asked
   * for arrives. Neither can hold a load back indefinitely.
   */
  isBusy: boolean
}

/**
 * The direction to load, or `null`. Pure: the caller reads the DOM once and
 * hands over the numbers.
 */
export const resolvePagingLoad = ({
  direction,
  distanceToTop,
  distanceToBottom,
  threshold,
  hasEarlierMessages,
  hasNewerMessages,
  isBusy,
}: PagingRequest): PagingDirection | null => {
  if (isBusy) {
    return null
  }

  if (direction === 'earlier') {
    return hasEarlierMessages && distanceToTop <= threshold ? 'earlier' : null
  }

  return hasNewerMessages && distanceToBottom <= threshold ? 'newer' : null
}

/**
 * Whether the input that produced this event was aimed at something else.
 *
 * Timeline content holds scrollable regions of its own — tool-call output,
 * error details, approval lists, an open message editor — and wheel and touch
 * events bubble out of them. Scrolling inside one of those must not page the
 * conversation just because the conversation happens to be sitting near an
 * edge, so an ancestor that can still move in the requested direction claims
 * the input.
 *
 * Overflowing is not the same as scrolling: a clamped preview or any wrapper
 * with `overflow: hidden` is taller than its box and permanently pinned at
 * `scrollTop` 0, and letting that claim the input would silently disable
 * paging for everything inside it. `isScrollable` is supplied by the caller
 * because answering it means reading computed style, which is a DOM concern
 * and — in a popout — a question for that document's own view.
 *
 * Walks with `parentElement` and duck-typed scroll metrics rather than
 * `instanceof`: in a popout the nodes belong to another document whose
 * constructors are not this realm's.
 */
export const isPagingInputClaimedByNestedScroller = (
  target: Element | null,
  scrollerElement: Element,
  direction: PagingDirection,
  isScrollable: (element: Element) => boolean,
): boolean => {
  let node = target
  while (node && node !== scrollerElement) {
    const maxScrollTop = node.scrollHeight - node.clientHeight
    if (maxScrollTop > 0) {
      const canMove =
        direction === 'earlier'
          ? node.scrollTop > 0
          : node.scrollTop < maxScrollTop
      if (canMove && isScrollable(node)) {
        return true
      }
    }
    node = node.parentElement
  }
  return false
}

/**
 * Which turn to hold the viewport against across a window change, given the
 * turn the reader is actually looking at.
 *
 * A window at its maximum size slides instead of growing, keeping only
 * `retainedTurns` turns next to the edge being loaded. The viewport can span
 * more turns than that when they are short, so the turn nearest the top may be
 * one of the ones about to be unmounted — and an anchor that no longer exists
 * means no compensation and a visible jump. Clamping into the provably kept
 * range trades the closest turn for the closest *surviving* one.
 *
 * `direction` is `null` when the window is only growing, where nothing is
 * dropped and the reader's own turn is always the right answer.
 */
export const getRetainedAnchorIndex = (
  selectedIndex: number,
  anchorCount: number,
  direction: PagingDirection | null,
  retainedTurns: number,
): number => {
  if (anchorCount <= 0) {
    return 0
  }

  const clampedIndex =
    direction === 'earlier'
      ? Math.min(selectedIndex, retainedTurns - 1)
      : direction === 'newer'
        ? Math.max(selectedIndex, anchorCount - retainedTurns)
        : selectedIndex
  return Math.max(0, Math.min(clampedIndex, anchorCount - 1))
}
