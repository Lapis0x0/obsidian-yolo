import OpenAI from 'openai'

import { LLMRequest } from '../../types/llm/request'

import { OpenAIMessageAdapter } from './openaiMessageAdapter'
import { LLMResponseFormatError } from './responseFormatError'

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

  parseNonStreaming(raw: unknown) {
    return this.parseNonStreamingResponse(raw as never)
  }

  parseStreaming(raw: unknown) {
    return this.parseStreamingResponseChunk(raw as never)
  }

  /**
   * Drives the real `streamResponse` entry point with a stub client, so the
   * test covers the same path a provider takes instead of reaching into the
   * adapter's internals.
   */
  async collectStream(rawChunks: unknown[]) {
    const client = {
      chat: {
        completions: {
          create: () =>
            Promise.resolve(
              (async function* () {
                for (const chunk of rawChunks) {
                  yield chunk as never
                }
              })(),
            ),
        },
      },
    } as unknown as OpenAI

    const stream = await this.streamResponse(client, {
      model: 'gpt-5.4-mini',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    })

    const parsed = []
    for await (const chunk of stream) {
      parsed.push(chunk)
    }
    return parsed
  }
}

const textChunk = (id: string, content: string) => ({
  id,
  object: 'chat.completion.chunk',
  model: 'gpt-5.4-mini',
  choices: [{ index: 0, delta: { content }, finish_reason: null }],
})

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

  it('collapses text-only user content parts into legacy string content', () => {
    const params = adapter.buildParams({
      model: 'legacy-openai-compatible-model',
      stream: false,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: '你是？' }],
        },
      ],
    }) as unknown as {
      messages: Array<{ role: string; content: string }>
    }

    expect(params.messages[0]?.content).toBe('你是？')
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

  it('throws a useful format error when a non-streaming response is missing choices', () => {
    let caught: unknown
    try {
      adapter.parseNonStreaming({
        error: {
          message: 'The model does not support this request.',
          type: 'invalid_request_error',
          code: 'unsupported_model',
        },
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(LLMResponseFormatError)
    expect((caught as LLMResponseFormatError).payload).toMatchObject({
      adapter: 'OpenAI-compatible',
      stage: 'non-streaming response',
      expected: 'choices_array',
      problem: { type: 'missing_choices' },
      responseKeys: ['error'],
      upstreamError: {
        message: 'The model does not support this request.',
        type: 'invalid_request_error',
        code: 'unsupported_model',
      },
      preview:
        '{"error":{"message":"The model does not support this request.","type":"invalid_request_error","code":"unsupported_model"}}',
    })
  })

  it('throws a useful format error when a streaming chunk has invalid choices', () => {
    let caught: unknown
    try {
      adapter.parseStreaming({
        id: 'chunk-1',
        choices: null,
        message: 'Invalid stream payload',
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(LLMResponseFormatError)
    expect((caught as LLMResponseFormatError).payload).toMatchObject({
      adapter: 'OpenAI-compatible',
      stage: 'streaming response chunk',
      expected: 'choices_array',
      problem: { type: 'invalid_choices', actualType: 'null' },
      responseKeys: ['id', 'choices', 'message'],
      upstreamMessage: 'Invalid stream payload',
      preview:
        '{"id":"chunk-1","choices":null,"message":"Invalid stream payload"}',
    })
  })
  it('skips relay keep-alive frames that carry no choices', async () => {
    const chunks = await adapter.collectStream([
      { type: 'ping' },
      textChunk('chunk-1', 'Hello'),
      {},
      textChunk('chunk-2', ' world'),
    ])

    expect(chunks.map((chunk) => chunk.choices[0]?.delta.content)).toEqual([
      'Hello',
      ' world',
    ])
  })

  it('reports a format error when the whole stream never carried choices', async () => {
    let caught: unknown
    try {
      await adapter.collectStream([
        { type: 'message_start', message: { id: 'msg_1' } },
        { type: 'content_block_delta', delta: { text: 'Hello' } },
      ])
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(LLMResponseFormatError)
    expect((caught as LLMResponseFormatError).payload).toMatchObject({
      adapter: 'OpenAI-compatible',
      stage: 'streaming response chunk',
      expected: 'choices_array',
      problem: { type: 'missing_choices' },
      responseKeys: ['type', 'message'],
    })
  })

  it('reports an upstream error frame immediately, even after valid chunks', async () => {
    let caught: unknown
    try {
      await adapter.collectStream([
        textChunk('chunk-1', 'Hello'),
        { error: { message: 'upstream is overloaded', type: 'server_error' } },
        textChunk('chunk-2', ' world'),
      ])
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(LLMResponseFormatError)
    expect((caught as LLMResponseFormatError).payload).toMatchObject({
      stage: 'streaming response chunk',
      upstreamError: {
        message: 'upstream is overloaded',
        type: 'server_error',
      },
    })
  })

  it('accepts a stream that ends without any chunk at all', async () => {
    await expect(adapter.collectStream([])).resolves.toEqual([])
  })
})
