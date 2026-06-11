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

  it('does not forward internal reasoningLevel as a vendor extension', () => {
    const params = adapter.buildParams({
      model: 'gpt-5.4-mini',
      stream: true,
      reasoningLevel: 'off',
      reasoning: {
        effort: 'none',
        exclude: true,
      },
      messages: [
        {
          role: 'user',
          content: 'hello',
        },
      ],
    }) as unknown as Record<string, unknown>

    expect(params.reasoning).toEqual({
      effort: 'none',
      exclude: true,
    })
    expect(params.reasoningLevel).toBeUndefined()
  })

  it('translates document content parts into OpenAI file content (OpenRouter-style PDF passthrough)', () => {
    const params = adapter.buildParams({
      model: 'gemini-2.5-flash',
      stream: false,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '看一下这份 PDF' },
            {
              type: 'document',
              mediaType: 'application/pdf',
              name: 'resume.pdf',
              data: 'JVBERi0xLjQK', // %PDF-1.4 base64 prefix
              pageCount: 3,
            },
          ],
        },
      ],
    }) as unknown as {
      messages: Array<{
        role: string
        content: Array<Record<string, unknown>>
      }>
    }

    expect(params.messages[0]?.content).toEqual([
      { type: 'text', text: '看一下这份 PDF' },
      {
        type: 'file',
        file: {
          filename: 'resume.pdf',
          file_data: 'data:application/pdf;base64,JVBERi0xLjQK',
        },
      },
    ])
  })
})
