import { LLMRequest } from '../../types/llm/request'

import { OpenAIMessageAdapter } from './openaiMessageAdapter'

class TestOpenAIMessageAdapter extends OpenAIMessageAdapter {
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

describe('OpenAIMessageAdapter', () => {
  const adapter = new TestOpenAIMessageAdapter()

  it('merges hosted tools from extra_body.tools with existing function tools', () => {
    const params = adapter.buildParams({
      model: 'gpt-5.4-mini',
      stream: false,
      tool_choice: 'auto',
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            parameters: {
              type: 'object',
              properties: {},
            },
          },
        },
      ],
      extra_body: {
        tools: [{ type: 'web_search' }],
      },
      messages: [
        {
          role: 'user',
          content: 'hello',
        },
      ],
    } as LLMRequest & {
      extra_body: {
        tools: Array<{ type: 'web_search' }>
      }
    }) as unknown as Record<string, unknown>

    expect(params.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'read_file',
          parameters: {
            type: 'object',
            properties: {},
          },
        },
      },
      {
        type: 'web_search',
      },
    ])
    expect('tool_choice' in params).toBe(false)
  })

  it('drops empty assistant shell messages before building chat params', () => {
    const params = adapter.buildParams({
      model: 'moonshot-v1-8k',
      stream: false,
      messages: [
        {
          role: 'user',
          content: 'hello',
        },
        {
          role: 'assistant',
          content: '',
        },
        {
          role: 'assistant',
          content: 'world',
        },
      ],
    }) as unknown as {
      messages: Array<{ role: string; content: string }>
    }

    expect(params.messages).toEqual([
      {
        role: 'user',
        content: 'hello',
      },
      {
        role: 'assistant',
        content: 'world',
      },
    ])
  })
})
