import type {
  Response,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses'

import { ChatGPTOAuthResponsesAdapter } from './chatgptOAuthResponsesAdapter'

describe('ChatGPTOAuthResponsesAdapter', () => {
  const adapter = new ChatGPTOAuthResponsesAdapter()

  it('builds responses input from chat messages and tool outputs', () => {
    const request = adapter.buildRequest({
      model: 'gpt-5.4',
      stream: false,
      tool_choice: 'auto',
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read a file',
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string' },
              },
            },
          },
        },
      ],
      messages: [
        {
          role: 'system',
          content: 'You are helpful.',
        },
        {
          role: 'user',
          content: 'Read README.md',
        },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              name: 'read_file',
              arguments: {
                kind: 'complete',
                value: { path: 'README.md' },
              },
            },
          ],
        },
        {
          role: 'tool',
          tool_call: {
            id: 'call_1',
            name: 'read_file',
          },
          content: '# Hello',
        },
      ],
    })

    expect(request.input).toEqual([
      {
        role: 'user',
        content: 'Read README.md',
        type: 'message',
      },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"README.md"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: '# Hello',
      },
    ])
    expect(request.instructions).toBe('You are helpful.')
  })

  it('maps hosted web search tools to responses web search preview tools', () => {
    const request = adapter.buildRequest({
      model: 'gpt-5.4',
      stream: false,
      tools: [{ type: 'web_search' } as never],
      messages: [
        {
          role: 'user',
          content: 'What happened today?',
        },
      ],
    })

    expect(request.tools).toEqual([{ type: 'web_search_preview' }])
  })

  it('keeps standard Responses sampling and output limit fields by default', () => {
    const request = adapter.buildRequest({
      model: 'gpt-5.4',
      stream: true,
      max_tokens: 256,
      temperature: 0.4,
      top_p: 0.9,
      messages: [{ role: 'user', content: 'Hello' }],
    })

    expect(request.max_output_tokens).toBe(256)
    expect(request.temperature).toBe(0.4)
    expect(request.top_p).toBe(0.9)
  })

  it('omits Codex-unsupported fields from generated and extra request params', () => {
    const requestWithExtraParams = Object.assign(
      {
        model: 'gpt-5.3-codex-spark',
        stream: true,
        max_tokens: 256,
        temperature: 0.4,
        top_p: 0.9,
        messages: [{ role: 'user' as const, content: 'Hello' }],
      },
      { max_output_tokens: 512 },
    )

    const request = adapter.buildRequest(requestWithExtraParams, {
      profile: 'codex',
    })

    expect(request).not.toHaveProperty('max_output_tokens')
    expect(request).not.toHaveProperty('temperature')
    expect(request).not.toHaveProperty('top_p')
  })

  it('parses non-streaming responses into chat completion shape', () => {
    const response = {
      id: 'resp_1',
      created_at: 123,
      model: 'gpt-5.4',
      status: 'completed',
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: null,
      output_text: 'Done',
      parallel_tool_calls: true,
      temperature: null,
      tool_choice: 'auto',
      tools: [],
      top_p: null,
      max_output_tokens: null,
      previous_response_id: null,
      reasoning: null,
      store: false,
      truncation: 'disabled',
      user: null,
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 5,
        output_tokens_details: { reasoning_tokens: 2 },
        total_tokens: 15,
      },
      output: [
        {
          id: 'rs_1',
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'step 1' }],
          status: 'completed',
        },
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: 'Done',
              annotations: [
                {
                  type: 'url_citation',
                  url: 'https://example.com',
                  title: 'Example',
                  start_index: 0,
                  end_index: 4,
                },
              ],
            },
          ],
        },
        {
          id: 'fc_1',
          type: 'function_call',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '{"path":"README.md"}',
          status: 'completed',
        },
      ],
    } as unknown as Response

    expect(adapter.parseResponse(response)).toEqual({
      id: 'resp_1',
      created: 123,
      model: 'gpt-5.4',
      object: 'chat.completion',
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: 'Done',
            reasoning: 'step 1',
            annotations: [
              {
                type: 'url_citation',
                url_citation: {
                  url: 'https://example.com',
                  title: 'Example',
                  start_index: 0,
                  end_index: 4,
                },
              },
            ],
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: '{"path":"README.md"}',
                },
              },
            ],
          },
        },
      ],
    })
  })

  it('maps stream events to text and tool call deltas', () => {
    const state = adapter.createStreamState()
    const events: ResponseStreamEvent[] = [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          id: 'fc_1',
          type: 'function_call',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '',
          status: 'in_progress',
        },
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        output_index: 0,
        delta: '{"path":"REA',
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 1,
        content_index: 0,
        delta: 'Done',
      },
    ]

    const chunks = events.flatMap((event) =>
      Array.from(adapter.parseStreamEvent(event, state)),
    )

    expect(chunks).toEqual([
      {
        id: 'fc_1',
        model: 'chatgpt-oauth',
        object: 'chat.completion.chunk',
        choices: [
          {
            finish_reason: null,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'read_file',
                    arguments: '',
                  },
                },
              ],
            },
          },
        ],
      },
      {
        id: 'fc_1',
        model: 'chatgpt-oauth',
        object: 'chat.completion.chunk',
        choices: [
          {
            finish_reason: null,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: {
                    arguments: '{"path":"REA',
                  },
                },
              ],
            },
          },
        ],
      },
      {
        id: 'msg_1',
        model: 'chatgpt-oauth',
        object: 'chat.completion.chunk',
        choices: [
          {
            finish_reason: null,
            delta: {
              content: 'Done',
            },
          },
        ],
      },
    ])
  })

  it('parses non-streaming responses when reasoning items omit summary', () => {
    const response = {
      id: 'resp_2',
      created_at: 456,
      model: 'gpt-5.4',
      status: 'completed',
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: null,
      output_text: 'Done',
      parallel_tool_calls: true,
      temperature: null,
      tool_choice: 'auto',
      tools: [],
      top_p: null,
      max_output_tokens: null,
      previous_response_id: null,
      reasoning: null,
      store: false,
      truncation: 'disabled',
      user: null,
      usage: {
        input_tokens: 1,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 1,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 2,
      },
      output: [
        {
          id: 'rs_1',
          type: 'reasoning',
          status: 'completed',
        },
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: 'Done',
              annotations: [],
            },
          ],
        },
      ],
    } as unknown as Response

    const parsed = adapter.parseResponse(response)
    expect(parsed.choices[0].message.content).toBe('Done')
    expect(parsed.choices[0].message).not.toHaveProperty('reasoning')
  })

  it('handles response.output_item.done for reasoning items without summary', () => {
    const state = adapter.createStreamState()
    const event = {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: 'rs_1',
        type: 'reasoning',
        status: 'completed',
      },
    } as unknown as ResponseStreamEvent

    const chunks = Array.from(adapter.parseStreamEvent(event, state))
    expect(chunks).toEqual([])
  })

  it('maps reasoning summary part and delta events', () => {
    const state = adapter.createStreamState()
    const events = [
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_1',
        summary_index: 0,
        delta: 'First summary part',
      },
      {
        type: 'response.reasoning_summary_part.added',
        item_id: 'rs_1',
        summary_index: 1,
      },
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_1',
        summary_index: 1,
        delta: 'Second summary part',
      },
    ] as unknown as ResponseStreamEvent[]

    const chunks = events.flatMap((event) =>
      Array.from(adapter.parseStreamEvent(event, state)),
    )

    expect(chunks).toEqual([
      {
        id: 'rs_1',
        model: 'chatgpt-oauth',
        object: 'chat.completion.chunk',
        choices: [
          {
            finish_reason: null,
            delta: {
              reasoning: 'First summary part',
            },
          },
        ],
      },
      {
        id: 'rs_1',
        model: 'chatgpt-oauth',
        object: 'chat.completion.chunk',
        choices: [
          {
            finish_reason: null,
            delta: {
              reasoning: '\n\n',
            },
          },
        ],
      },
      {
        id: 'rs_1',
        model: 'chatgpt-oauth',
        object: 'chat.completion.chunk',
        choices: [
          {
            finish_reason: null,
            delta: {
              reasoning: 'Second summary part',
            },
          },
        ],
      },
    ])
  })
})
