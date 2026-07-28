import { resolveAutoFollowFromScroll } from './useAutoScroll'

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
