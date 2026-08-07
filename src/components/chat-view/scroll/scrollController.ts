/**
 * Single arbiter for chat scrollTop writes.
 *
 * useAutoScroll (live-edge follow) and ChatTimelineList (history-window
 * anchor compensation, windowNavigation jump) used to each write
 * `element.scrollTop` directly from their own rAF/layout-effect timing,
 * racing one another. They now submit intents here instead; the controller
 * holds the only rAF queue and the only place that writes scrollTop, so at
 * most one write happens per frame and a higher-priority intent always wins
 * a contested frame.
 */

export type ScrollTargetResolver = () => number | null

export type ScrollController = {
  bindElement(element: HTMLElement | null): void
  submitJumpToMessage(
    resolve: ScrollTargetResolver,
    observe: Element | null,
  ): void
  submitPreserveAnchor(
    resolve: ScrollTargetResolver,
    observe: Element | null,
  ): void
  submitFollowLiveEdge(resolve: ScrollTargetResolver): void
  cancelFollowLiveEdge(): void
  /**
   * Synchronous hard reset to a target position: discards every pending
   * intent (they reference the previous conversation's anchors) and writes
   * scrollTop immediately. Must be callable from a layout effect so a
   * conversation switch lands before paint — routing it through the rAF
   * queue would flash one frame of the list at the stale position.
   */
  snapNow(resolve: ScrollTargetResolver): void
  /**
   * True while a jumpToMessage/preserveAnchor intent is still settling.
   * ChatTimelineList uses this instead of a fixed timestamp window to
   * suppress load-more triggers caused by the compensating scroll itself.
   */
  isSettling(): boolean
  dispose(): void
}

const SCROLL_EPSILON_PX = 1
// Two consecutive settlement checks resolving to the same target is treated
// as "layout has stopped moving."
const SETTLEMENT_STABLE_TICKS = 2
// Safety net for ObsidianMarkdown's async second-pass layout (e.g. LaTeX)
// landing later than any ResizeObserver signal we happen to see.
const SETTLEMENT_TIMEOUT_MS = 400

type IntentKind = 'jumpToMessage' | 'preserveAnchor' | 'followLiveEdge'

// User gesture beats everything (handled upstream by not submitting at all,
// or by cancelFollowLiveEdge). Among submitted intents: an explicit jump
// wins over an in-flight anchor compensation, which wins over passive
// live-edge following.
const INTENT_PRIORITY: readonly IntentKind[] = [
  'jumpToMessage',
  'preserveAnchor',
  'followLiveEdge',
]

type Intent = {
  resolve: ScrollTargetResolver
  settle: boolean
  lastTarget: number | null
  stableTicks: number
  observer: ResizeObserver | null
  timeoutId: ReturnType<typeof setTimeout> | null
}

export function createScrollController(): ScrollController {
  let boundElement: HTMLElement | null = null
  let frameHandle: number | null = null
  const intents = new Map<IntentKind, Intent>()

  const clearIntent = (kind: IntentKind) => {
    const intent = intents.get(kind)
    if (!intent) {
      return
    }
    intent.observer?.disconnect()
    if (intent.timeoutId !== null) {
      clearTimeout(intent.timeoutId)
    }
    intents.delete(kind)
  }

  const cancelFrame = () => {
    if (frameHandle !== null) {
      cancelAnimationFrame(frameHandle)
      frameHandle = null
    }
  }

  const scheduleFlush = () => {
    if (frameHandle !== null || intents.size === 0 || !boundElement) {
      return
    }
    frameHandle = requestAnimationFrame(flush)
  }

  function flush() {
    frameHandle = null
    const element = boundElement
    if (!element) {
      return
    }

    const activeKind = INTENT_PRIORITY.find((kind) => intents.has(kind))
    if (!activeKind) {
      return
    }
    const intent = intents.get(activeKind)
    if (!intent) {
      return
    }

    const target = intent.resolve()
    if (
      target !== null &&
      Math.abs(element.scrollTop - target) > SCROLL_EPSILON_PX
    ) {
      element.scrollTop = target
    }

    if (!intent.settle) {
      // One-shot: executed (or a no-op resolve), done either way.
      clearIntent(activeKind)
      scheduleFlush()
      return
    }

    const isStableTick =
      target !== null &&
      intent.lastTarget !== null &&
      Math.abs(intent.lastTarget - target) <= SCROLL_EPSILON_PX
    intent.stableTicks = isStableTick ? intent.stableTicks + 1 : 0
    intent.lastTarget = target

    if (intent.stableTicks >= SETTLEMENT_STABLE_TICKS) {
      clearIntent(activeKind)
      scheduleFlush()
    }
    // Otherwise wait for the next ResizeObserver signal or the timeout.
  }

  const submitSettlementIntent = (
    kind: 'jumpToMessage' | 'preserveAnchor',
    resolve: ScrollTargetResolver,
    observe: Element | null,
  ) => {
    clearIntent(kind)
    const observer =
      observe && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => scheduleFlush())
        : null
    if (observer && observe) {
      observer.observe(observe)
    }
    const timeoutId = setTimeout(() => {
      clearIntent(kind)
      scheduleFlush()
    }, SETTLEMENT_TIMEOUT_MS)
    intents.set(kind, {
      resolve,
      settle: true,
      lastTarget: null,
      stableTicks: 0,
      observer,
      timeoutId,
    })
    scheduleFlush()
  }

  return {
    bindElement(next) {
      if (next === boundElement) {
        return
      }
      for (const kind of [...intents.keys()]) {
        clearIntent(kind)
      }
      cancelFrame()
      boundElement = next
    },
    submitJumpToMessage(resolve, observe) {
      submitSettlementIntent('jumpToMessage', resolve, observe)
    },
    submitPreserveAnchor(resolve, observe) {
      submitSettlementIntent('preserveAnchor', resolve, observe)
    },
    submitFollowLiveEdge(resolve) {
      clearIntent('followLiveEdge')
      intents.set('followLiveEdge', {
        resolve,
        settle: false,
        lastTarget: null,
        stableTicks: 0,
        observer: null,
        timeoutId: null,
      })
      scheduleFlush()
    },
    cancelFollowLiveEdge() {
      clearIntent('followLiveEdge')
    },
    snapNow(resolve) {
      for (const kind of [...intents.keys()]) {
        clearIntent(kind)
      }
      cancelFrame()
      const element = boundElement
      if (!element) {
        return
      }
      const target = resolve()
      if (
        target !== null &&
        Math.abs(element.scrollTop - target) > SCROLL_EPSILON_PX
      ) {
        element.scrollTop = target
      }
    },
    isSettling() {
      return intents.has('jumpToMessage') || intents.has('preserveAnchor')
    },
    dispose() {
      for (const kind of [...intents.keys()]) {
        clearIntent(kind)
      }
      cancelFrame()
      boundElement = null
    },
  }
}
