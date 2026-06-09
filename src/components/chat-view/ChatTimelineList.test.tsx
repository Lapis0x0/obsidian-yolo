jest.mock('react', () => {
  const actual = jest.requireActual('react')
  return {
    ...actual,
    useLayoutEffect: actual.useEffect,
  }
})

jest.mock('../../contexts/app-context', () => ({
  useApp: () => ({}),
}))

jest.mock('../../contexts/settings-context', () => ({
  useSettings: () => ({ settings: {} }),
}))

jest.mock('../../database/json/chat/timelineHeightCacheStore', () => ({
  flushPersistedTimelineHeightCache: jest.fn(),
  hydratePersistedTimelineHeightCache: jest.fn().mockResolvedValue(undefined),
  schedulePersistedTimelineHeightCacheFlush: jest.fn(),
}))

// Mock react-virtuoso so we can assert that the Footer component is rendered
// in the virtualized branch without depending on real DOM layout / measurement.
jest.mock('react-virtuoso', () => {
  const React = jest.requireActual('react')
  type MockProps = {
    data?: unknown[]
    itemContent?: (index: number, item: unknown) => React.ReactNode
    components?: { Footer?: React.ComponentType<{ context?: unknown }> }
    context?: unknown
    className?: string
    style?: React.CSSProperties
    heightEstimates?: number[]
    initialTopMostItemIndex?: unknown
    restoreStateFrom?: unknown
  }
  return {
    __esModule: true,
    Virtuoso: (props: MockProps) => {
      const Footer = props.components?.Footer
      const initialTopMostItemIndex =
        typeof props.initialTopMostItemIndex === 'object' &&
        props.initialTopMostItemIndex !== null
          ? (props.initialTopMostItemIndex as {
              align?: unknown
              index?: unknown
            })
          : null
      return React.createElement(
        'div',
        {
          'data-testid': 'mock-virtuoso',
          'data-has-restore-state': props.restoreStateFrom ? 'true' : 'false',
          'data-height-estimates': props.heightEstimates?.join(','),
          'data-initial-align':
            initialTopMostItemIndex?.align === undefined
              ? undefined
              : // eslint-disable-next-line @typescript-eslint/no-base-to-string -- align is a string enum value in test assertions
                String(initialTopMostItemIndex.align),
          'data-initial-index': initialTopMostItemIndex
            ? String(initialTopMostItemIndex.index)
            : props.initialTopMostItemIndex === undefined
              ? undefined
              : // eslint-disable-next-line @typescript-eslint/no-base-to-string -- primitive index value in test assertions
                String(props.initialTopMostItemIndex),
          className: props.className,
          style: props.style,
        },
        ...(props.data ?? []).map((item, index) =>
          React.createElement(
            React.Fragment,
            { key: index },
            props.itemContent?.(index, item) ?? null,
          ),
        ),
        Footer
          ? React.createElement(Footer, {
              context: props.context,
              key: '__footer',
            })
          : null,
      )
    },
  }
})

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { StateSnapshot } from 'react-virtuoso'

import type { ChatTimelineItem } from '../../types/chat-timeline'
import {
  buildTimelineSignature,
  hydrateTimelineHeightCache,
  setTimelineStateSnapshot,
} from '../../utils/chat/timeline-virtualization-cache'
import { ChatTimelineList } from './ChatTimelineList'

function makeUserItem(id: string): ChatTimelineItem {
  return {
    kind: 'user-message',
    id,
    renderKey: id,
    estimatedHeight: 80,
    message: {
      role: 'user',
      id,
      content: {},
      mentionables: [],
      reasoningLevel: 'none',
      timestamp: 0,
    },
  } as unknown as ChatTimelineItem
}

function renderList(props: {
  items: ChatTimelineItem[]
  bottomSpacerHeight?: number
  conversationId?: string
  virtualizationThreshold?: number
}) {
  const ref = { current: null } as React.RefObject<HTMLElement>
  return renderToStaticMarkup(
    <ChatTimelineList
      items={props.items}
      conversationId={props.conversationId}
      scrollContainerRef={ref}
      virtualizationThreshold={props.virtualizationThreshold}
      bottomSpacerHeight={props.bottomSpacerHeight}
      renderItem={(item) => (
        <div data-testid="row" data-key={item.renderKey}>
          {item.renderKey}
        </div>
      )}
    />,
  )
}

describe('ChatTimelineList bottomSpacerHeight', () => {
  it('renders a spacer div at the tail of the non-virtualized branch', () => {
    const html = renderList({
      items: [makeUserItem('a'), makeUserItem('b')],
      bottomSpacerHeight: 120,
      virtualizationThreshold: 50, // force non-virtualized
    })

    expect(html).toContain('yolo-chat-timeline-bottom-spacer')
    expect(html).toContain('height:120px')
    // Spacer should come after the last item.
    const spacerIndex = html.indexOf('yolo-chat-timeline-bottom-spacer')
    const lastRowIndex = html.lastIndexOf('data-key="b"')
    expect(spacerIndex).toBeGreaterThan(lastRowIndex)
  })

  it('omits the spacer when height is 0 in the non-virtualized branch', () => {
    const html = renderList({
      items: [makeUserItem('a')],
      bottomSpacerHeight: 0,
      virtualizationThreshold: 50,
    })

    expect(html).not.toContain('yolo-chat-timeline-bottom-spacer')
  })

  it('renders the Footer spacer in the virtualized branch', () => {
    const items = Array.from({ length: 60 }, (_, i) => makeUserItem(`m-${i}`))
    const html = renderList({
      items,
      bottomSpacerHeight: 88,
      virtualizationThreshold: 24,
    })

    expect(html).toContain('mock-virtuoso')
    expect(html).toContain('yolo-chat-timeline-bottom-spacer')
    expect(html).toContain('height:88px')
  })

  it('does not render a Footer node when virtualized and spacer height is 0', () => {
    const items = Array.from({ length: 60 }, (_, i) => makeUserItem(`m-${i}`))
    const html = renderList({
      items,
      bottomSpacerHeight: 0,
      virtualizationThreshold: 24,
    })

    expect(html).toContain('mock-virtuoso')
    expect(html).not.toContain('yolo-chat-timeline-bottom-spacer')
  })
})

describe('ChatTimelineList virtualized initial position', () => {
  it('starts virtualized conversations at the bottom when no state was saved', () => {
    const items = Array.from({ length: 60 }, (_, i) => makeUserItem(`m-${i}`))
    const html = renderList({
      items,
      virtualizationThreshold: 24,
    })

    expect(html).toContain('mock-virtuoso')
    expect(html).toContain('data-initial-index="LAST"')
    expect(html).toContain('data-initial-align="end"')
  })

  it('prefers a saved Virtuoso state over bottom initialization', () => {
    const conversationId = 'chat-timeline-list-test-restore-state'
    const items = Array.from({ length: 60 }, (_, i) => makeUserItem(`m-${i}`))

    setTimelineStateSnapshot({
      scope: {
        conversationId,
        widthBucket: 0,
        styleSignature: 'default',
      },
      timelineSignature: buildTimelineSignature(items),
      snapshot: {
        ranges: [],
        scrollTop: 240,
      } satisfies StateSnapshot,
    })

    const html = renderList({
      items,
      conversationId,
      virtualizationThreshold: 24,
    })

    expect(html).toContain('mock-virtuoso')
    expect(html).toContain('data-has-restore-state="true"')
    expect(html).not.toContain('data-initial-index=')
  })
})

describe('ChatTimelineList virtualized height estimates', () => {
  it('does not let a stale tiny cached height undercut the current item estimate', () => {
    const conversationId = 'chat-timeline-list-test-stale-height'
    const items = Array.from({ length: 60 }, (_, i) => makeUserItem(`m-${i}`))
    items[0] = {
      ...items[0],
      estimatedHeight: 500,
    }

    hydrateTimelineHeightCache([
      {
        scope: {
          conversationId,
          widthBucket: 0,
          styleSignature: 'default',
        },
        updatedAt: Date.now(),
        heights: {
          'm-0': 68,
        },
      },
    ])

    const html = renderList({
      items,
      conversationId,
      virtualizationThreshold: 24,
    })

    expect(html).toContain('mock-virtuoso')
    expect(html).toContain('data-height-estimates="500,80')
  })
})
