import { LLMRequest } from '../../types/llm/request'

import { QwenOAuthMessageAdapter } from './qwenOAuthMessageAdapter'

class TestQwenOAuthMessageAdapter extends QwenOAuthMessageAdapter {
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

describe('QwenOAuthMessageAdapter', () => {
  const adapter = new TestQwenOAuthMessageAdapter()

  it('collapses pure text user content parts into a string', () => {
    const params = adapter.buildParams({
      model: 'coder-model',
      stream: false,
      messages: [
        {
          role: 'system',
          content: 'system prompt',
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'hello',
            },
          ],
        },
      ],
    }) as unknown as {
      messages: Array<{
        role: string
        content: string | Array<unknown>
      }>
    }

    expect(params.messages).toEqual([
      {
        role: 'system',
        content: 'system prompt',
      },
      {
        role: 'user',
        content: 'hello',
      },
    ])
  })

  it('preserves multimodal content arrays when an image is present', () => {
    const params = adapter.buildParams({
      model: 'coder-model',
      stream: false,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: 'data:image/png;base64,abc',
              },
            },
            {
              type: 'text',
              text: 'describe this image',
            },
          ],
        },
      ],
    }) as unknown as {
      messages: Array<{
        role: string
        content: string | Array<unknown>
      }>
    }

    expect(params.messages).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: 'data:image/png;base64,abc',
            },
          },
          {
            type: 'text',
            text: 'describe this image',
          },
        ],
      },
    ])
  })

  it('drops empty assistant shell messages', () => {
    const params = adapter.buildParams({
      model: 'coder-model',
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
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'world',
            },
          ],
        },
      ],
    }) as unknown as {
      messages: Array<{
        role: string
        content: string | Array<unknown>
      }>
    }

    expect(params.messages).toEqual([
      {
        role: 'user',
        content: 'hello',
      },
      {
        role: 'user',
        content: 'world',
      },
    ])
  })
})
