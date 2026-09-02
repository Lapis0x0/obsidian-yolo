import type OpenAI from 'openai'
import type {
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses'

import { ChatModel } from '../../types/chat-model.types'
import { LLMRequestNonStreaming } from '../../types/llm/request'

import { ChatGPTOAuthProvider } from './chatgptOAuthProvider'

const model: ChatModel = {
  providerId: 'chatgpt-oauth',
  id: 'gpt-5.6-sol',
  model: 'gpt-5.6-sol',
}

const request: LLMRequestNonStreaming = {
  model: 'gpt-5.6-sol',
  stream: false,
  messages: [{ role: 'user', content: 'Summarize this chat in a few words.' }],
}

const createProvider = (events: ResponseStreamEvent[]) => {
  const provider = new ChatGPTOAuthProvider({
    id: 'chatgpt-oauth',
    presetType: 'chatgpt-oauth',
    apiType: 'openai-responses',
    additionalSettings: { requestTransportMode: 'browser' },
  })
  const create = jest.fn().mockResolvedValue({
    [Symbol.asyncIterator]: async function* () {
      for (const event of events) {
        yield event
      }
    },
  })
  const client = { responses: { create } } as unknown as OpenAI
  Object.assign(provider, {
    browserClient: client,
    obsidianClient: client,
    nodeClient: client,
  })
  return { provider, create }
}

const completed = (
  output: unknown[],
  usage?: Record<string, number>,
): ResponseStreamEvent =>
  ({
    type: 'response.completed',
    response: {
      id: 'resp_1',
      created_at: 1,
      model: 'gpt-5.6-sol',
      status: 'completed',
      output,
      ...(usage ? { usage } : {}),
    },
  }) as unknown as ResponseStreamEvent

const messageItem = (id: string, text: string) => ({
  id,
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
})

const itemDone = (outputIndex: number, item: unknown): ResponseStreamEvent =>
  ({
    type: 'response.output_item.done',
    output_index: outputIndex,
    item,
  }) as unknown as ResponseStreamEvent

describe('ChatGPTOAuthProvider.generateResponse', () => {
  // The Codex endpoint only streams, so buffered callers (conversation titles,
  // other lightweight requests) fold the stream back into one response. Its
  // terminal event carries an empty `output`; the produced items only ever
  // arrive as `response.output_item.done`.
  it('rebuilds the response from streamed output items', async () => {
    const { provider, create } = createProvider([
      {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        delta: 'Weekend trip',
      } as unknown as ResponseStreamEvent,
      itemDone(0, messageItem('msg_1', 'Weekend trip plan')),
      completed([], {
        input_tokens: 12,
        output_tokens: 3,
        total_tokens: 15,
      }),
    ])

    const response = await provider.generateResponse(model, request)

    expect(response.choices[0].message.content).toBe('Weekend trip plan')
    expect(response.choices[0].finish_reason).toBe('stop')
    expect(response.usage?.total_tokens).toBe(15)
    // Codex has no buffered endpoint — the request itself is always streamed.
    expect(
      (create.mock.calls[0][0] as ResponseCreateParamsStreaming).stream,
    ).toBe(true)
  })

  it('rebuilds tool calls and orders items by their output index', async () => {
    const { provider } = createProvider([
      // Completion order deliberately differs from the response order, so a
      // rebuild that trusted arrival order would reverse both pairs below.
      itemDone(3, {
        id: 'fc_2',
        type: 'function_call',
        call_id: 'call_2',
        name: 'grep',
        arguments: '{"query":"yolo"}',
      }),
      itemDone(2, {
        id: 'fc_1',
        type: 'function_call',
        call_id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"README.md"}',
      }),
      itemDone(1, messageItem('msg_2', ' Then I will grep.')),
      itemDone(0, messageItem('msg_1', 'Reading the file.')),
      completed([]),
    ])

    const choice = (await provider.generateResponse(model, request)).choices[0]

    expect(choice.message.content).toBe('Reading the file. Then I will grep.')
    expect(choice.message.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"README.md"}' },
      },
      {
        id: 'call_2',
        type: 'function',
        function: { name: 'grep', arguments: '{"query":"yolo"}' },
      },
    ])
    expect(choice.finish_reason).toBe('tool_calls')
  })

  it('keeps the terminal response output when the backend sends it', async () => {
    const { provider } = createProvider([
      itemDone(0, messageItem('msg_1', 'Streamed draft')),
      completed([messageItem('msg_1', 'Final answer')]),
    ])

    const response = await provider.generateResponse(model, request)

    expect(response.choices[0].message.content).toBe('Final answer')
  })

  it('rebuilds an incomplete response the same way', async () => {
    const { provider } = createProvider([
      itemDone(0, messageItem('msg_1', 'Half a th')),
      {
        type: 'response.incomplete',
        response: {
          id: 'resp_2',
          created_at: 2,
          model: 'gpt-5.6-sol',
          status: 'incomplete',
          output: [],
        },
      } as unknown as ResponseStreamEvent,
    ])

    const response = await provider.generateResponse(model, request)

    expect(response.choices[0].message.content).toBe('Half a th')
    expect(response.choices[0].finish_reason).toBe('length')
  })
})

describe('ChatGPTOAuthProvider hosted web search', () => {
  // The Codex backend rejects `web_search_preview` with HTTP 400, so the tool
  // has to reach it under the bare `web_search` type.
  it('sends the hosted search tool as web_search', async () => {
    const { provider, create } = createProvider([completed([])])

    await provider.generateResponse(
      {
        ...model,
        builtinToolProvider: 'gpt',
        builtinTools: { gpt: { webSearch: { enabled: true } } },
      },
      request,
    )

    expect(
      (create.mock.calls[0][0] as ResponseCreateParamsStreaming).tools,
    ).toEqual([{ type: 'web_search' }])
  })
})
