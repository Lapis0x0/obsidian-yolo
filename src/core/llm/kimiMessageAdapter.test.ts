import { LLMRequest } from '../../types/llm/request'
import { createCompleteToolCallArguments } from '../../types/tool-call.types'

import { KimiMessageAdapter } from './kimiMessageAdapter'

class TestKimiMessageAdapter extends KimiMessageAdapter {
  buildParams(request: LLMRequest) {
    if (request.stream === true) {
      return this.buildChatCompletionCreateParams({
        request,
        stream: true,
      })
    }

    return this.buildChatCompletionCreateParams({
      request,
      stream: false,
    })
  }
}

describe('KimiMessageAdapter', () => {
  const adapter = new TestKimiMessageAdapter()

  it('fills empty assistant tool-call content with a space', () => {
    const params = adapter.buildParams({
      model: 'kimi-k2.5',
      stream: false,
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call-1',
              name: 'read_file',
              arguments: createCompleteToolCallArguments({ value: {} }),
            },
          ],
        },
      ],
    }) as unknown as {
      messages: Array<{
        role: string
        content: string
        tool_calls?: Array<unknown>
        reasoning_content?: string
      }>
    }

    expect(params.messages).toEqual([
      {
        role: 'assistant',
        content: ' ',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: '{}',
            },
          },
        ],
      },
    ])
  })

  it('maps assistant reasoning to reasoning_content', () => {
    const params = adapter.buildParams({
      model: 'kimi-k2.5',
      stream: false,
      messages: [
        {
          role: 'assistant',
          content: 'answer',
          reasoning: 'thinking',
        },
      ],
    }) as unknown as {
      messages: Array<{
        role: string
        content: string
        reasoning_content?: string
      }>
    }

    expect(params.messages).toEqual([
      {
        role: 'assistant',
        content: 'answer',
        reasoning_content: 'thinking',
      },
    ])
  })
})
