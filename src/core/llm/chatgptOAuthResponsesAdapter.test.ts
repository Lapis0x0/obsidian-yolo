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
        role: 'system',
        content: 'You are helpful.',
        type: 'message',
      },
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
})
