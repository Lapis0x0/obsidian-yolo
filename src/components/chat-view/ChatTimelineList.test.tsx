jest.mock('react', () => {
  const actual = jest.requireActual('react')
  return {
    ...actual,
    useLayoutEffect: actual.useEffect,
  }
})

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { ChatTimelineItem } from '../../types/chat-timeline'

import { ChatTimelineList, getVisibleUserMessageIds } from './ChatTimelineList'

function makeUserItem(id: string): ChatTimelineItem {
  return {
    kind: 'user-message',
    id,
    renderKey: id,
    estimatedHeight: 80,
    messageId: id,
    revision: 1,
  }
}

function renderList(props: {
  items: ChatTimelineItem[]
  bottomSpacerHeight?: number
  hasEarlierMessages?: boolean
  hasNewerMessages?: boolean
}) {
  const ref = { current: null } as React.RefObject<HTMLElement>
  return renderToStaticMarkup(
    <ChatTimelineList
      items={props.items}
      scrollContainerRef={ref}
      bottomSpacerHeight={props.bottomSpacerHeight}
      hasEarlierMessages={props.hasEarlierMessages}
      hasNewerMessages={props.hasNewerMessages}
      onLoadEarlier={props.hasEarlierMessages ? jest.fn() : undefined}
      onLoadNewer={props.hasNewerMessages ? jest.fn() : undefined}
      renderItem={(item) => (
        <div data-testid="row" data-key={item.renderKey}>
          {item.renderKey}
        </div>
      )}
    />,
  )
}

describe('ChatTimelineList windowed timeline', () => {
  it('renders all items in the current window', () => {
    const html = renderList({
      items: Array.from({ length: 12 }, (_, i) => makeUserItem(`m-${i}`)),
    })

    expect(html).toContain('data-key="m-0"')
    expect(html).toContain('data-key="m-11"')
    expect(html).not.toContain('mock-virtuoso')
  })

  it('renders a spacer div at the tail', () => {
    const html = renderList({
      items: [makeUserItem('a'), makeUserItem('b')],
      bottomSpacerHeight: 120,
    })

    expect(html).toContain('yolo-chat-timeline-bottom-spacer')
    expect(html).toContain('height:120px')
    const spacerIndex = html.indexOf('yolo-chat-timeline-bottom-spacer')
    const lastRowIndex = html.lastIndexOf('data-key="b"')
    expect(spacerIndex).toBeGreaterThan(lastRowIndex)
  })

  it('omits the spacer when height is 0', () => {
    const html = renderList({
      items: [makeUserItem('a')],
      bottomSpacerHeight: 0,
    })

    expect(html).not.toContain('yolo-chat-timeline-bottom-spacer')
  })

  it('renders load sentinels for unloaded history edges', () => {
    const html = renderList({
      items: [makeUserItem('a')],
      hasEarlierMessages: true,
      hasNewerMessages: true,
    })

    expect(html).toContain('Load earlier messages')
    expect(html).toContain('Load newer messages')
    expect(html).toContain('role="status"')
    expect(html).not.toContain('role="button"')
    expect(html).not.toContain('tabindex="0"')
  })

  it('uses messageId for user scroll anchors', () => {
    const html = renderList({
      items: [makeUserItem('user-anchor')],
    })

    expect(html).toContain('data-yolo-user-anchor-id="user-anchor"')
  })
})

describe('getVisibleUserMessageIds', () => {
  const anchors = [
    { messageId: 'first', top: -300 },
    { messageId: 'second', top: 240 },
    { messageId: 'third', top: 680 },
  ]

  it('keeps a turn visible while its assistant response intersects the viewport', () => {
    expect(
      getVisibleUserMessageIds({
        anchors,
        contentBottom: 900,
        viewportTop: 0,
        viewportBottom: 200,
      }),
    ).toEqual(['first'])
  })

  it('returns every turn crossed by the viewport', () => {
    expect(
      getVisibleUserMessageIds({
        anchors,
        contentBottom: 900,
        viewportTop: 200,
        viewportBottom: 300,
      }),
    ).toEqual(['first', 'second'])
  })

  it('does not extend the last turn beyond the rendered conversation content', () => {
    expect(
      getVisibleUserMessageIds({
        anchors,
        contentBottom: 900,
        viewportTop: 910,
        viewportBottom: 1000,
      }),
    ).toEqual([])
  })
})
