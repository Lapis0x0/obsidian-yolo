import type { ChatAssistantMessage, ChatToolMessage } from '../../types/chat'
import type { ChatModel } from '../../types/chat-model.types'
import type { ResponseUsage } from '../../types/llm/response'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

import { collectLLMResponseInfo } from './useLLMResponseInfo'

const model: ChatModel = {
  id: 'model-1',
  providerId: 'chatgpt-oauth/default',
  model: 'gpt-test',
  name: 'GPT Test',
}

const makeAssistant = (
  id: string,
  promptTokens: number,
  completionTokens: number,
  durationMs: number,
  extraUsage: Partial<ResponseUsage> = {},
): ChatAssistantMessage => ({
  role: 'assistant',
  id,
  content: '',
  metadata: {
    model,
    durationMs,
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      ...extraUsage,
    },
  },
})

const toolMessage: ChatToolMessage = {
  role: 'tool',
  id: 'tool-1',
  toolCalls: [
    {
      request: {
        id: 'tool-call-1',
        name: 'tool',
        arguments: {
          kind: 'complete',
          value: {},
          rawText: '{}',
        },
      },
      response: {
        status: ToolCallResponseStatus.Success,
        data: {
          type: 'text',
          text: 'ok',
        },
      },
    },
  ],
}

describe('collectLLMResponseInfo', () => {
  it('single request: top-level = that request, no total', () => {
    const info = collectLLMResponseInfo([
      makeAssistant('assistant-1', 100, 20, 1000, {
        cache_read_input_tokens: 10,
      }),
    ])

    expect(info.requestCount).toBe(1)
    expect(info.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      cache_read_input_tokens: 10,
    })
    expect(info.durationMs).toBe(1000)
    expect(info.totalUsage).toBeNull()
    expect(info.totalDurationMs).toBeNull()
    expect(info.totalCost).toBeNull()

    // Single billable call still surfaces as a request entry for the
    // breakdown view (which won't actually render at requestCount < 2).
    expect(info.requests).toHaveLength(1)
    expect(info.requests[0].index).toBe(1)
    expect(info.requests[0].messageId).toBe('assistant-1')
  })

  it('multi request: top-level = last call, total = sum across calls', () => {
    const info = collectLLMResponseInfo([
      makeAssistant('assistant-1', 100, 20, 1000, {
        cache_read_input_tokens: 10,
      }),
      toolMessage,
      makeAssistant('assistant-2', 200, 30, 1500, {
        cache_read_input_tokens: 150,
        cache_creation_input_tokens: 15,
      }),
    ])

    expect(info.requestCount).toBe(2)

    // Top-level reflects only the last call (what the user sees as "this turn").
    expect(info.usage).toEqual({
      prompt_tokens: 200,
      completion_tokens: 30,
      total_tokens: 230,
      cache_read_input_tokens: 150,
      cache_creation_input_tokens: 15,
    })
    expect(info.durationMs).toBe(1500)

    // Aggregates expose the full picture for the multi-call surface.
    expect(info.totalUsage).toEqual({
      prompt_tokens: 300,
      completion_tokens: 50,
      total_tokens: 350,
      cache_read_input_tokens: 160,
      cache_creation_input_tokens: 15,
    })
    expect(info.totalDurationMs).toBe(2500)
    expect(info.totalCost).toBe(0)

    // Each billable call gets a dense entry with its own usage/duration.
    expect(info.requests).toHaveLength(2)
    expect(info.requests.map((r) => r.index)).toEqual([1, 2])
    expect(info.requests[0].usage.prompt_tokens).toBe(100)
    expect(info.requests[0].durationMs).toBe(1000)
    expect(info.requests[1].usage.prompt_tokens).toBe(200)
    expect(info.requests[1].durationMs).toBe(1500)
  })

  it('duration-only assistant in the middle does not occupy an index slot', () => {
    // A duration-only assistant between two billable calls must not bump the
    // index — the breakdown list would otherwise show "1, 3" with no row 2.
    const durationOnly: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-noop',
      content: '',
      metadata: { model, durationMs: 9999 },
    }
    const info = collectLLMResponseInfo([
      makeAssistant('assistant-1', 100, 20, 1000),
      durationOnly,
      makeAssistant('assistant-2', 200, 30, 1500),
    ])

    expect(info.requests).toHaveLength(2)
    expect(info.requests.map((r) => r.index)).toEqual([1, 2])
    expect(info.requests.map((r) => r.messageId)).toEqual([
      'assistant-1',
      'assistant-2',
    ])
  })

  it('duration-only assistant trailing after a usage call is ignored', () => {
    // Old code paired the usage from call 1 with the durationMs from the
    // trailing duration-only assistant, producing a bogus tok/s. Top-level
    // must bind usage+duration to the same call entry.
    const durationOnly: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-2',
      content: '',
      metadata: { model, durationMs: 9999 },
    }
    const info = collectLLMResponseInfo([
      makeAssistant('assistant-1', 100, 20, 1000),
      durationOnly,
    ])

    expect(info.requestCount).toBe(1)
    expect(info.usage?.prompt_tokens).toBe(100)
    expect(info.durationMs).toBe(1000) // bound to the same call as `usage`
    expect(info.totalUsage).toBeNull()
    expect(info.totalDurationMs).toBeNull()
  })

  it('any counted call missing duration → totalDurationMs is null', () => {
    const missingDuration: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-2',
      content: '',
      metadata: {
        model,
        // no durationMs
        usage: {
          prompt_tokens: 50,
          completion_tokens: 10,
          total_tokens: 60,
        },
      },
    }
    const info = collectLLMResponseInfo([
      makeAssistant('assistant-1', 100, 20, 1000),
      missingDuration,
    ])

    expect(info.requestCount).toBe(2)
    expect(info.totalUsage).not.toBeNull()
    expect(info.totalDurationMs).toBeNull()
    expect(info.durationMs).toBeNull() // last call had no duration
  })

  it('any counted call missing model → totalCost is null', () => {
    const noModel: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-2',
      content: '',
      metadata: {
        durationMs: 500,
        usage: {
          prompt_tokens: 50,
          completion_tokens: 10,
          total_tokens: 60,
        },
      },
    }
    const info = collectLLMResponseInfo([
      makeAssistant('assistant-1', 100, 20, 1000),
      noModel,
    ])

    expect(info.requestCount).toBe(2)
    expect(info.totalCost).toBeNull()
  })

  it('summed total_tokens is recomputed from prompt+completion', () => {
    // Mismatched upstream total_tokens (e.g. anthropic cache quirks) must
    // not leak into the displayed total.
    const info = collectLLMResponseInfo([
      {
        role: 'assistant',
        id: 'assistant-1',
        content: '',
        metadata: {
          model,
          durationMs: 100,
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 999, // garbage from upstream
          },
        },
      },
      {
        role: 'assistant',
        id: 'assistant-2',
        content: '',
        metadata: {
          model,
          durationMs: 100,
          usage: {
            prompt_tokens: 200,
            completion_tokens: 30,
            total_tokens: 111, // garbage from upstream
          },
        },
      },
    ])

    expect(info.totalUsage?.total_tokens).toBe(350) // 300 + 50, not 999+111
  })

  it('shows sub-model task child usage without counting it in main totals', () => {
    const subModelToolMessage: ChatToolMessage = {
      ...toolMessage,
      toolCalls: [
        {
          ...toolMessage.toolCalls[0],
          request: {
            ...toolMessage.toolCalls[0].request,
            name: 'yolo_local__run_model_task',
          },
          response: {
            status: ToolCallResponseStatus.Success,
            data: {
              type: 'text',
              text: JSON.stringify({
                ok: true,
                childOutput: 'child result',
                meta: {
                  childUsage: {
                    prompt_tokens: 30,
                    completion_tokens: 5,
                    total_tokens: 35,
                  },
                  childDurationMs: 250,
                },
              }),
            },
          },
        },
      ],
    }
    const info = collectLLMResponseInfo([
      makeAssistant('assistant-1', 100, 20, 1000),
      subModelToolMessage,
    ])

    expect(info.requestCount).toBe(1)
    expect(info.hasSubModelCalls).toBe(true)
    expect(info.totalUsage).toBeNull()
    expect(info.requests).toHaveLength(2)
    expect(info.requests.map((request) => request.index)).toEqual([1, '-'])
    expect(info.requests.map((request) => request.kind)).toEqual([
      'main',
      'sub-model',
    ])
    expect(info.requests[1].usage).toEqual({
      prompt_tokens: 30,
      completion_tokens: 5,
      total_tokens: 35,
    })
    expect(info.requests[1].durationMs).toBe(250)
  })
})
