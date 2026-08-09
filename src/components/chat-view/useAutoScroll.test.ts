import {
  resolveAutoFollowFromScroll,
  resolveTouchScrollDirection,
  shouldFollowAfterLiveEdgeExit,
} from './useAutoScroll'

describe('resolveTouchScrollDirection', () => {
  it('maps a downward finger movement to scrolling toward earlier content', () => {
    expect(resolveTouchScrollDirection(100, 120, null)).toBe('up')
  })

  it('maps an upward finger movement to scrolling toward the live edge', () => {
    expect(resolveTouchScrollDirection(120, 100, null)).toBe('down')
  })

  it('keeps the confirmed direction through sub-pixel touch jitter', () => {
    expect(resolveTouchScrollDirection(100, 100.5, 'up')).toBe('up')
  })

  it('ignores small movement before a touch direction is confirmed', () => {
    expect(resolveTouchScrollDirection(100, 103, null)).toBeNull()
  })
})

describe('resolveAutoFollowFromScroll', () => {
  it('detaches when confirmed user intent moves the viewport upward', () => {
    expect(
      resolveAutoFollowFromScroll({
        isFollowing: true,
        previousScrollTop: 1000,
        currentScrollTop: 990,
        distanceToBottom: 10,
        allowDetach: true,
        allowReattach: false,
      }),
    ).toBe(false)
  })

  it('keeps following when layout changes move the viewport upward', () => {
    expect(
      resolveAutoFollowFromScroll({
        isFollowing: true,
        previousScrollTop: 1000,
        currentScrollTop: 990,
        distanceToBottom: 10,
        allowDetach: false,
        allowReattach: false,
      }),
    ).toBe(true)
  })

  it('stays detached while streamed content grows below the viewport', () => {
    expect(
      resolveAutoFollowFromScroll({
        isFollowing: false,
        previousScrollTop: 700,
        currentScrollTop: 700,
        distanceToBottom: 500,
        allowDetach: false,
        allowReattach: false,
      }),
    ).toBe(false)
  })

  it('stays detached when scrolling down away from the live edge', () => {
    expect(
      resolveAutoFollowFromScroll({
        isFollowing: false,
        previousScrollTop: 700,
        currentScrollTop: 760,
        distanceToBottom: 140,
        allowDetach: false,
        allowReattach: true,
      }),
    ).toBe(false)
  })

  it('does not reattach after a programmatic scroll to the live edge', () => {
    expect(
      resolveAutoFollowFromScroll({
        isFollowing: false,
        previousScrollTop: 900,
        currentScrollTop: 990,
        distanceToBottom: 10,
        allowDetach: false,
        allowReattach: false,
      }),
    ).toBe(false)
  })

  it('reattaches after the user scrolls down to the live edge', () => {
    expect(
      resolveAutoFollowFromScroll({
        isFollowing: false,
        previousScrollTop: 900,
        currentScrollTop: 990,
        distanceToBottom: 10,
        allowDetach: false,
        allowReattach: true,
      }),
    ).toBe(true)
  })
})

describe('shouldFollowAfterLiveEdgeExit', () => {
  const base = {
    isIntersecting: false,
    isFollowing: true,
    canFollowLiveEdge: true,
    hasActiveFollowSession: true,
  }

  it('follows an asynchronous layout change during a live-content update', () => {
    expect(shouldFollowAfterLiveEdgeExit(base)).toBe(true)
  })

  it('ignores a sentinel exit caused by a user disclosure toggle', () => {
    expect(
      shouldFollowAfterLiveEdgeExit({
        ...base,
        hasActiveFollowSession: false,
      }),
    ).toBe(false)
  })

  it('never follows when the surface is showing an older history window', () => {
    expect(
      shouldFollowAfterLiveEdgeExit({
        ...base,
        canFollowLiveEdge: false,
      }),
    ).toBe(false)
  })
})
