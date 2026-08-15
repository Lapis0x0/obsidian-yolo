import type { PagingDirection, PagingInputNode, PagingRequest } from './paging'
import {
  getKeyPagingDirection,
  getRetainedAnchorIndex,
  getScrollPagingDirection,
  getTouchPagingDirection,
  getWheelPagingDirection,
  isPagingInputClaimedByNestedScroller,
  isTextEntryElement,
  resolvePagingLoad,
} from './paging'

describe('input direction', () => {
  it('reads wheel direction from the delta sign', () => {
    expect(getWheelPagingDirection(-3)).toBe('earlier')
    expect(getWheelPagingDirection(3)).toBe('newer')
    expect(getWheelPagingDirection(0)).toBeNull()
  })

  it('treats a finger moving down the screen as asking for earlier turns', () => {
    // The content follows the finger, so dragging down reveals what is above.
    expect(getTouchPagingDirection(100, 140)).toBe('earlier')
    expect(getTouchPagingDirection(140, 100)).toBe('newer')
    expect(getTouchPagingDirection(100, 100)).toBeNull()
  })

  it('reads scrollbar-drag direction from the resulting position', () => {
    expect(getScrollPagingDirection(500, 480)).toBe('earlier')
    expect(getScrollPagingDirection(480, 500)).toBe('newer')
    expect(getScrollPagingDirection(500, 500)).toBeNull()
  })

  it('maps the scrolling keys, with space reversing under shift', () => {
    expect(getKeyPagingDirection('PageUp', false)).toBe('earlier')
    expect(getKeyPagingDirection('Home', false)).toBe('earlier')
    expect(getKeyPagingDirection('PageDown', false)).toBe('newer')
    expect(getKeyPagingDirection('End', false)).toBe('newer')
    expect(getKeyPagingDirection(' ', false)).toBe('newer')
    expect(getKeyPagingDirection(' ', true)).toBe('earlier')
    expect(getKeyPagingDirection('a', false)).toBeNull()
    expect(getKeyPagingDirection('Enter', false)).toBeNull()
  })
})

const node = (overrides: Partial<PagingInputNode> = {}): PagingInputNode => ({
  tagName: 'DIV',
  scrollTop: 0,
  scrollHeight: 100,
  clientHeight: 100,
  getAttribute: () => null,
  parentElement: null,
  ...overrides,
})

/** Links the given nodes parent-to-child and returns the innermost one. */
const nest = (...nodes: PagingInputNode[]): PagingInputNode =>
  nodes.reduce((parent, child) => {
    child.parentElement = parent
    return child
  })

describe('isTextEntryElement', () => {
  it('recognises the places a scrolling key is really a typing key', () => {
    expect(isTextEntryElement(node({ tagName: 'TEXTAREA' }))).toBe(true)
    expect(isTextEntryElement(node({ tagName: 'INPUT' }))).toBe(true)
    expect(isTextEntryElement(node({ tagName: 'SELECT' }))).toBe(true)
    expect(isTextEntryElement(node({ getAttribute: () => 'true' }))).toBe(true)
  })

  it('looks up the tree, not just at the target itself', () => {
    const target = nest(
      node({ getAttribute: () => 'true' }),
      node({ tagName: 'SPAN' }),
    )
    expect(isTextEntryElement(target)).toBe(true)
  })

  it('leaves ordinary content and controls alone', () => {
    expect(isTextEntryElement(node({ tagName: 'BUTTON' }))).toBe(false)
    expect(isTextEntryElement(node({ tagName: 'P' }))).toBe(false)
    expect(isTextEntryElement(node({ getAttribute: () => 'false' }))).toBe(
      false,
    )
    expect(isTextEntryElement(null)).toBe(false)
  })
})

describe('isPagingInputClaimedByNestedScroller', () => {
  it('lets a nested region with room left keep the input', () => {
    // Tool-call output half scrolled: both directions are still its own.
    const scroller = node()
    const target = nest(
      scroller,
      node({ scrollTop: 200, scrollHeight: 600, clientHeight: 300 }),
      node({ tagName: 'SPAN' }),
    )

    expect(
      isPagingInputClaimedByNestedScroller(target, scroller, 'earlier'),
    ).toBe(true)
    expect(
      isPagingInputClaimedByNestedScroller(target, scroller, 'newer'),
    ).toBe(true)
  })

  it('releases the direction a nested region has run out of', () => {
    // Scrolled to its own top: further "earlier" belongs to the conversation,
    // while "newer" is still the nested region's to consume.
    const scroller = node()
    const target = nest(
      scroller,
      node({ scrollTop: 0, scrollHeight: 600, clientHeight: 300 }),
      node({ tagName: 'SPAN' }),
    )

    expect(
      isPagingInputClaimedByNestedScroller(target, scroller, 'earlier'),
    ).toBe(false)
    expect(
      isPagingInputClaimedByNestedScroller(target, scroller, 'newer'),
    ).toBe(true)
  })

  it('ignores nested elements that do not scroll at all', () => {
    const scroller = node()
    const target = nest(
      scroller,
      node({ scrollTop: 0, scrollHeight: 300, clientHeight: 300 }),
      node({ tagName: 'SPAN' }),
    )

    expect(
      isPagingInputClaimedByNestedScroller(target, scroller, 'earlier'),
    ).toBe(false)
  })

  it('stops at the scroller and never lets it claim its own input', () => {
    const scroller = node({
      scrollTop: 500,
      scrollHeight: 2000,
      clientHeight: 400,
    })
    const target = nest(scroller, node({ tagName: 'SPAN' }))

    expect(
      isPagingInputClaimedByNestedScroller(target, scroller, 'earlier'),
    ).toBe(false)
    expect(
      isPagingInputClaimedByNestedScroller(null, scroller, 'earlier'),
    ).toBe(false)
  })
})

describe('resolvePagingLoad', () => {
  const request = (overrides: Partial<PagingRequest> = {}): PagingRequest => ({
    direction: 'earlier',
    distanceToTop: 100,
    distanceToBottom: 5000,
    threshold: 240,
    hasEarlierMessages: true,
    hasNewerMessages: true,
    isBusy: false,
    ...overrides,
  })

  it('loads the direction the reader asked for when they are near that edge', () => {
    expect(resolvePagingLoad(request())).toBe('earlier')
    expect(
      resolvePagingLoad(request({ direction: 'newer', distanceToBottom: 100 })),
    ).toBe('newer')
  })

  it('ignores the distance to the edge the reader is not asking for', () => {
    // Sitting at the top while scrolling down must not page earlier again.
    expect(
      resolvePagingLoad(request({ direction: 'newer', distanceToTop: 0 })),
    ).toBeNull()
  })

  it('does not load while the reader is far from the edge they asked for', () => {
    expect(resolvePagingLoad(request({ distanceToTop: 241 }))).toBeNull()
    expect(resolvePagingLoad(request({ distanceToTop: 240 }))).toBe('earlier')
  })

  it('does not load when that direction has nothing left', () => {
    expect(resolvePagingLoad(request({ hasEarlierMessages: false }))).toBeNull()
  })

  it('suppresses every direction while a load or correction is still in flight', () => {
    // The controller's own writes must never be compounded by a further load;
    // its settlement timeout bounds how long this can hold a load back.
    expect(resolvePagingLoad(request({ isBusy: true }))).toBeNull()
    expect(
      resolvePagingLoad(
        request({
          direction: 'newer',
          distanceToBottom: 0,
          isBusy: true,
        }),
      ),
    ).toBeNull()
  })

  it('still loads when the reader keeps pushing against an edge that cannot scroll', () => {
    // Pinned at the very top: the browser reports no scrolling at all, so only
    // the input event can express that they are still asking for more.
    expect(
      resolvePagingLoad(
        request({ distanceToTop: 0, distanceToBottom: 0, threshold: 240 }),
      ),
    ).toBe('earlier')
  })
})

describe('getRetainedAnchorIndex', () => {
  const RETAINED = 6

  it('keeps the reader’s own turn when it survives the change', () => {
    expect(getRetainedAnchorIndex(2, 12, 'earlier', RETAINED)).toBe(2)
    expect(getRetainedAnchorIndex(9, 12, 'newer', RETAINED)).toBe(9)
  })

  it('clamps into the turns a slide provably keeps', () => {
    // A full window sliding earlier drops turns 6..11, so an anchor there
    // would be gone by the time the restore looks for it.
    expect(getRetainedAnchorIndex(9, 12, 'earlier', RETAINED)).toBe(5)
    expect(getRetainedAnchorIndex(2, 12, 'newer', RETAINED)).toBe(6)
  })

  it('leaves the choice alone when the window only grows', () => {
    expect(getRetainedAnchorIndex(9, 12, null, RETAINED)).toBe(9)
  })

  it('never leaves the array when the window is smaller than a page', () => {
    const directions: (PagingDirection | null)[] = ['earlier', 'newer', null]
    for (const direction of directions) {
      for (let count = 1; count <= RETAINED; count++) {
        for (let selected = 0; selected < count; selected++) {
          const index = getRetainedAnchorIndex(
            selected,
            count,
            direction,
            RETAINED,
          )
          expect(index).toBeGreaterThanOrEqual(0)
          expect(index).toBeLessThan(count)
        }
      }
    }
  })

  it('is a no-op when there are no anchors at all', () => {
    expect(getRetainedAnchorIndex(0, 0, 'earlier', RETAINED)).toBe(0)
  })
})
