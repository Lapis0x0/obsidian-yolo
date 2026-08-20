import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { ChatAssistantMessage } from '../../types/chat'
import type {
  ChatTimelineAssistantGroupItem,
  ChatTimelineSessionFallbackDividerItem,
} from '../../types/chat-timeline'

jest.mock('./AssistantToolMessageGroupItem', () => ({
  __esModule: true,
  default: ({
    showBranchAction,
    showQuoteAction,
  }: {
    showBranchAction?: boolean
    showQuoteAction?: boolean
  }) => (
    <div
      data-branch={String(showBranchAction)}
      data-quote={String(showQuoteAction)}
    />
  ),
}))

import { getChatSurfacePreset } from './chat-surface-presets'
import type { ConversationTimelineRendererContract } from './conversation-surface-contract'
import { renderConversationTimelineItem } from './conversation-timeline-renderer'

const assistant: ChatAssistantMessage = {
  role: 'assistant',
  id: 'assistant-1',
  content: 'Done',
  metadata: { generationState: 'completed' },
}

const assistantItem: ChatTimelineAssistantGroupItem = {
  kind: 'assistant-group',
  id: assistant.id,
  renderKey: assistant.id,
  groupId: assistant.id,
  messageIds: [assistant.id],
  revision: 1,
}

const makeContract = (): ConversationTimelineRendererContract => ({
  messagesById: new Map([[assistant.id, assistant]]),
  preset: getChatSurfacePreset('cli'),
  compaction: {
    pendingTitle: 'Pending',
    pendingDescription: 'Pending description',
    dividerTitle: 'Divider',
    dividerDescription: 'Divider description',
  },
  renderUserMessage: () => null,
  getAssistantGroupProps: () =>
    ({
      conversationId: 'conversation-1',
      isApplying: false,
      activeApplyRequestKey: null,
    }) as ReturnType<
      ConversationTimelineRendererContract['getAssistantGroupProps']
    >,
  bottomAnchorClassName: 'yolo-test-bottom-anchor',
})

describe('renderConversationTimelineItem', () => {
  it('applies assistant action capabilities from the surface preset', () => {
    const html = renderToStaticMarkup(
      <>{renderConversationTimelineItem(assistantItem, makeContract())}</>,
    )

    expect(html).toContain('data-branch="false"')
    expect(html).toContain('data-quote="true"')
  })

  it('allows an adapter to narrow a per-group preset capability', () => {
    const contract = makeContract()
    contract.getAssistantActionOverrides = () => ({ showQuoteAction: false })

    const html = renderToStaticMarkup(
      <>{renderConversationTimelineItem(assistantItem, contract)}</>,
    )

    expect(html).toContain('data-quote="false"')
  })

  it('renders nothing for an unknown timeline kind', () => {
    const unknownItem = {
      ...assistantItem,
      kind: 'future-kind',
    } as unknown as Parameters<typeof renderConversationTimelineItem>[0]

    expect(
      renderConversationTimelineItem(unknownItem, makeContract()),
    ).toBeNull()
  })

  it('renders a session-fallback divider with its own per-item copy, reusing the compaction divider structure', () => {
    const sessionFallbackItem: ChatTimelineSessionFallbackDividerItem = {
      kind: 'session-fallback-divider',
      id: 'fallback-1-divider',
      renderKey: 'fallback-1-divider',
      anchorMessageId: assistant.id,
      title: 'Switched to default',
      description: 'The original agent "work" is unavailable.',
    }

    const html = renderToStaticMarkup(
      <>
        {renderConversationTimelineItem(sessionFallbackItem, makeContract())}
      </>,
    )

    // Reuses the exact compaction-divider CSS structure/classes.
    expect(html).toContain('yolo-chat-compaction-divider')
    expect(html).toContain('yolo-chat-compaction-divider__title')
    expect(html).toContain('yolo-chat-compaction-divider__description')
    // But renders the item's own copy, not the contract's shared
    // compaction copy.
    expect(html).toContain('Switched to default')
    expect(html).toContain(
      'The original agent &quot;work&quot; is unavailable.',
    )
    expect(html).not.toContain('Divider description')
  })
})
