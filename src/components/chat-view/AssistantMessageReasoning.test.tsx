jest.mock('../../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string, fallback?: string) => {
      if (key === 'chat.reasoning') return '思考过程'
      if (key === 'quickAsk.error') return '生成失败'
      if (key === 'quickAsk.statusGenerating') return '生成中...'
      return fallback ?? ''
    },
  }),
}))

jest.mock('./TransitioningMarkdown', () => ({
  __esModule: true,
  default: ({ content }: { content: string }) => <>{content}</>,
}))

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import AssistantMessageReasoning from './AssistantMessageReasoning'

describe('AssistantMessageReasoning', () => {
  it('keeps the reasoning title when the response generation fails', () => {
    const html = renderToStaticMarkup(
      <AssistantMessageReasoning
        reasoning="已有思考内容"
        hasAnswerContent
        generationState="error"
      />,
    )

    expect(html).toContain('思考过程')
    expect(html).not.toContain('生成失败')
    expect(html).toContain('data-stage="settled"')
  })

  it('keeps the reasoning title while more answer content is generated', () => {
    const html = renderToStaticMarkup(
      <AssistantMessageReasoning
        reasoning="已有思考内容"
        hasAnswerContent
        generationState="streaming"
      />,
    )

    expect(html).toContain('思考过程')
    expect(html).not.toContain('生成中')
    expect(html).toContain('data-stage="settled"')
  })
})
