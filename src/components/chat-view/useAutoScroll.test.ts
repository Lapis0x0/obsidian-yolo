import { resolveAutoFollowFromScroll } from './useAutoScroll'

describe('resolveAutoFollowFromScroll', () => {
  it('detaches on any upward movement, even inside the bottom threshold', () => {
    expect(
      resolveAutoFollowFromScroll({
        isFollowing: true,
        previousScrollTop: 1000,
        currentScrollTop: 990,
        distanceToBottom: 10,
        allowReattach: false,
      }),
    ).toBe(false)
  })

  it('stays detached while streamed content grows below the viewport', () => {
    expect(
      resolveAutoFollowFromScroll({
        isFollowing: false,
        previousScrollTop: 700,
        currentScrollTop: 700,
        distanceToBottom: 500,
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
        allowReattach: true,
      }),
    ).toBe(true)
  })

  it('keeps following when a viewport resize clamps the live edge upward', () => {
    expect(
      resolveAutoFollowFromScroll({
        isFollowing: true,
        previousScrollTop: 1000,
        currentScrollTop: 800,
        distanceToBottom: 0,
        allowReattach: false,
        isLayoutAdjustment: true,
      }),
    ).toBe(true)
  })
})
