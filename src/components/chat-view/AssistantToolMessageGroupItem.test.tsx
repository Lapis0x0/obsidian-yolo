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

jest.mock('../../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (_key: string, fallback?: string) => fallback ?? '',
  }),
}))

jest.mock('../../contexts/settings-context', () => ({
  useSettings: () => ({
    settings: {},
  }),
}))

jest.mock('../../database/json/chat/editReviewSnapshotStore', () => ({
  readEditReviewSnapshot: jest.fn(),
}))

jest.mock('./AssistantEditSummary', () => ({
  __esModule: true,
  default: () => null,
}))
jest.mock('./AssistantMessageAnnotations', () => ({
  __esModule: true,
  default: () => null,
}))
jest.mock('./AssistantMessageContent', () => ({
  __esModule: true,
  default: () => null,
}))
jest.mock('./AssistantMessageEditor', () => ({
  __esModule: true,
  default: () => null,
}))
jest.mock('./AssistantMessageReasoning', () => ({
  __esModule: true,
  default: () => null,
}))
jest.mock('./AssistantToolMessageGroupActions', () => ({
  __esModule: true,
  default: () => null,
}))
jest.mock('./LLMResponseInlineInfo', () => ({
  __esModule: true,
  default: () => null,
}))
jest.mock('./ToolMessage', () => ({
  __esModule: true,
  default: () => null,
}))

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { ChatAssistantMessage } from '../../types/chat'

import AssistantToolMessageGroupItem from './AssistantToolMessageGroupItem'

describe('AssistantToolMessageGroupItem', () => {
  it('renders an assistant error card even when the message has no content', () => {
    const assistantMessage: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-1',
      content: '',
      metadata: {
        generationState: 'error',
        errorMessage: '400 Reasoning is mandatory for this endpoint.',
      },
    }

    const html = renderToStaticMarkup(
      <AssistantToolMessageGroupItem
        messages={[assistantMessage]}
        conversationId="conversation-1"
        isApplying={false}
        activeApplyRequestKey={null}
        onApply={() => {}}
        onToolMessageUpdate={() => {}}
        onEditStart={() => {}}
        onEditCancel={() => {}}
        onEditSave={() => {}}
        onDeleteGroup={() => {}}
        onBranchGroup={() => {}}
        onQuoteAssistantSelection={() => {}}
        onOpenEditSummaryFile={() => {}}
      />,
    )

    expect(html).toContain('本次回复生成失败')
    expect(html).toContain('400 Reasoning is mandatory for this endpoint.')
  })
})
