import type Anthropic from '@anthropic-ai/sdk'

import { ChatModel } from '../../types/chat-model.types'
import { RequestTool } from '../../types/llm/request'
import { LLMProvider } from '../../types/provider.types'

import { AnthropicProvider } from './anthropic'

const provider: LLMProvider = {
  id: 'DeepSeek',
  presetType: 'deepseek',
  apiType: 'anthropic',
  apiKey: 'sk-test',
}

const model = (hostedSearch: boolean): ChatModel => ({
  providerId: 'DeepSeek',
  id: 'deepseek/deepseek-v4-flash',
  model: 'deepseek-v4-flash',
  builtinToolProvider: hostedSearch ? 'deepseek' : 'none',
  builtinTools: { deepseek: { webSearch: { enabled: hostedSearch } } },
})

// Built-in agent tools reach the model fully qualified, so our own web search
// never collides with the hosted tool's fixed `web_search` name.
const webSearchTool: RequestTool = {
  type: 'function',
  function: {
    name: 'yolo_local__web_search',
    description: 'YOLO web search',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
  },
}
const webScrapeTool: RequestTool = {
  type: 'function',
  function: {
    name: 'yolo_local__web_scrape',
    description: 'YOLO web scrape',
    parameters: { type: 'object', properties: { url: { type: 'string' } } },
  },
}

// `buildTools` is private; exercising it through the instance keeps the test
// on the real code path without exporting an implementation detail.
const buildTools = (chatModel: ChatModel, tools: RequestTool[]) =>
  (
    new AnthropicProvider(provider) as unknown as {
      buildTools: (m: ChatModel, r: { tools: RequestTool[] }) => unknown[]
    }
  ).buildTools(chatModel, { tools })

describe('AnthropicProvider hosted web search', () => {
  it('leaves function tools untouched when hosted search is off', () => {
    expect(buildTools(model(false), [webSearchTool, webScrapeTool])).toEqual([
      expect.objectContaining({ name: 'yolo_local__web_search' }),
      expect.objectContaining({ name: 'yolo_local__web_scrape' }),
    ])
  })

  it('appends the hosted tool alongside our own web search', () => {
    expect(buildTools(model(true), [webSearchTool, webScrapeTool])).toEqual([
      expect.objectContaining({ name: 'yolo_local__web_search' }),
      expect.objectContaining({ name: 'yolo_local__web_scrape' }),
      { type: 'web_search_20250305', name: 'web_search' },
    ])
  })

  it('declares the hosted tool even when the request carries no function tools', () => {
    expect(buildTools(model(true), [])).toEqual([
      { type: 'web_search_20250305', name: 'web_search' },
    ])
  })
})

describe('AnthropicProvider web_search_tool_result parsing', () => {
  const searchResultBlock = {
    type: 'web_search_tool_result',
    tool_use_id: 'call_0',
    content: [
      {
        type: 'web_search_result',
        title: 'DeepSeek V4-Flash',
        url: 'https://example.com/a',
        encrypted_content: 'opaque',
      },
      { type: 'web_search_result', url: 'https://example.com/b' },
    ],
  }

  it('turns the hosted-search receipt into url_citation annotations', () => {
    const response = {
      id: 'msg_1',
      model: 'deepseek-v4-flash',
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [
        {
          type: 'server_tool_use',
          id: 'call_0',
          name: 'web_search',
          input: {},
        },
        searchResultBlock,
        { type: 'text', text: 'answer' },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    } as unknown as Anthropic.Message

    const parsed = AnthropicProvider.parseNonStreamingResponse(response)
    expect(parsed.choices[0].message.annotations).toEqual([
      {
        type: 'url_citation',
        url_citation: {
          url: 'https://example.com/a',
          title: 'DeepSeek V4-Flash',
        },
      },
      { type: 'url_citation', url_citation: { url: 'https://example.com/b' } },
    ])
    // The hosted call must never surface as a tool call for the agent to run.
    expect(parsed.choices[0].message.tool_calls).toBeUndefined()
  })

  it('emits annotations from the streaming receipt block', () => {
    const chunk = AnthropicProvider.parseStreamingResponseChunk(
      {
        type: 'content_block_start',
        index: 3,
        content_block: searchResultBlock,
      } as never,
      'msg_1',
      'deepseek-v4-flash',
    )
    expect(chunk?.choices[0].delta.annotations).toHaveLength(2)
  })

  it('ignores the error variant of the receipt', () => {
    const response = {
      id: 'msg_2',
      model: 'deepseek-v4-flash',
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [
        {
          type: 'web_search_tool_result',
          tool_use_id: 'call_0',
          content: {
            type: 'web_search_tool_result_error',
            error_code: 'max_uses_exceeded',
          },
        },
        { type: 'text', text: 'answer' },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    } as unknown as Anthropic.Message

    expect(
      AnthropicProvider.parseNonStreamingResponse(response).choices[0].message
        .annotations,
    ).toBeUndefined()
  })
})

describe('AnthropicProvider hosted-search streaming receipt', () => {
  // Mirrors the real DeepSeek event order: the call's query streams as
  // `input_json_delta`, and its results arrive later in a separate block.
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        model: 'deepseek-v4-flash',
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'server_tool_use',
        id: 'call_0',
        name: 'web_search',
        input: {},
      },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"query": "Deep' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: 'Seek V4"}' },
    },
    {
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'web_search_tool_result',
        tool_use_id: 'call_0',
        content: [
          {
            type: 'web_search_result',
            title: 'A',
            url: 'https://example.com/a',
          },
        ],
      },
    },
    {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'text_delta', text: 'answer' },
    },
  ]

  const collect = async () => {
    const stream = (async function* () {
      for (const event of events) yield event
    })()
    const gen = (
      new AnthropicProvider(provider) as unknown as {
        streamResponseGenerator: (s: unknown) => AsyncIterable<{
          choices?: { delta?: Record<string, any> }[]
        }>
      }
    ).streamResponseGenerator(stream)
    const chunks = []
    for await (const chunk of gen) chunks.push(chunk)
    return chunks
  }

  it('never leaks the hosted call into tool-call deltas', async () => {
    const chunks = await collect()
    // `input_json_delta` is the same delta type function tool calls use; if it
    // reached the accumulator the agent would try to execute a phantom call.
    expect(
      chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? []),
    ).toHaveLength(0)
  })

  it('pairs the streamed query with the results that arrive later', async () => {
    const chunks = await collect()
    const last = chunks
      .map((c) => c.choices?.[0]?.delta?.providerMetadata?.hostedWebSearch)
      .filter(Boolean)
      .pop()
    expect(last).toEqual([
      {
        id: 'call_0',
        query: 'DeepSeek V4',
        results: [{ url: 'https://example.com/a', title: 'A' }],
      },
    ])
  })

  it('still yields the assistant text', async () => {
    const chunks = await collect()
    expect(
      chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join(''),
    ).toBe('answer')
  })
})
