import { LLMRequestNonStreaming, RequestMessage } from '../../types/llm/request'

import { OpenAIMessageAdapter } from './openaiMessageAdapter'
import { DeepSeekMessageAdapter } from './deepseekMessageAdapter'

class TestableOpenAIMessageAdapter extends OpenAIMessageAdapter {
  public parseRequestMessageForTest(message: RequestMessage) {
    return this.parseRequestMessage(message)
  }

  public buildChatCompletionCreateParamsForTest(
    request: LLMRequestNonStreaming,
  ) {
    return this.buildChatCompletionCreateParams({ request, stream: false })
  }
}

class TestableDeepSeekMessageAdapter extends DeepSeekMessageAdapter {
  public parseRequestMessageForTest(message: RequestMessage) {
    return this.parseRequestMessage(message)
  }
}

describe('OpenAIMessageAdapter', () => {
  it('normalizes malformed assistant tool arguments to an empty object', () => {
    const adapter = new TestableOpenAIMessageAdapter()
    const message: RequestMessage = {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'toolu_123',
          name: 'yolo_local__fs_edit',
          arguments: '{"path":"note.md","newText":"He said "ok""}',
        },
      ],
    }

    const parsed = adapter.parseRequestMessageForTest(message)
    expect(parsed.role).toBe('assistant')
    if (!('tool_calls' in parsed) || !parsed.tool_calls?.length) {
      throw new Error('Expected assistant tool calls in parsed message')
    }

    expect(parsed.tool_calls[0].function.arguments).toBe('{}')
  })

  it('keeps valid assistant tool arguments as JSON object text', () => {
    const adapter = new TestableOpenAIMessageAdapter()
    const message: RequestMessage = {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'toolu_456',
          name: 'yolo_local__fs_edit',
          arguments:
            '{"path":"note.md","operations":[{"type":"replace","oldText":"foo","newText":"bar"}]}',
        },
      ],
    }

    const parsed = adapter.parseRequestMessageForTest(message)
    expect(parsed.role).toBe('assistant')
    if (!('tool_calls' in parsed) || !parsed.tool_calls?.length) {
      throw new Error('Expected assistant tool calls in parsed message')
    }

    expect(JSON.parse(parsed.tool_calls[0].function.arguments)).toEqual({
      path: 'note.md',
      operations: [
        {
          type: 'replace',
          oldText: 'foo',
          newText: 'bar',
        },
      ],
    })
  })

  it('passes through unknown request fields for OpenAI-compatible extensions', () => {
    const adapter = new TestableOpenAIMessageAdapter()
    const request = {
      model: 'qwen3-max',
      messages: [{ role: 'user', content: '你好' }],
      enable_thinking: true,
    } as LLMRequestNonStreaming & Record<string, unknown>

    const params = adapter.buildChatCompletionCreateParamsForTest(request)
    const record = params as unknown as Record<string, unknown>

    expect(record.enable_thinking).toBe(true)
  })

  it('does not send reasoning_content for generic OpenAI requests', () => {
    const adapter = new TestableOpenAIMessageAdapter()
    const message: RequestMessage = {
      role: 'assistant',
      content: '',
      reasoning: 'step by step',
      tool_calls: [
        {
          id: 'toolu_789',
          name: 'yolo_local__fs_edit',
          arguments: '{}',
        },
      ],
    }

    const parsed = adapter.parseRequestMessageForTest(
      message,
    ) as unknown as Record<string, unknown>

    expect(parsed).not.toHaveProperty('reasoning_content')
  })

  it('sends reasoning_content for DeepSeek assistant tool calls', () => {
    const adapter = new TestableDeepSeekMessageAdapter()
    const message: RequestMessage = {
      role: 'assistant',
      content: '',
      reasoning: 'step by step',
      tool_calls: [
        {
          id: 'toolu_999',
          name: 'yolo_local__fs_edit',
          arguments: '{}',
        },
      ],
    }

    const parsed = adapter.parseRequestMessageForTest(
      message,
    ) as unknown as Record<string, unknown>

    expect(parsed.reasoning_content).toBe('step by step')
  })

  it('does not include unknown fields when value is undefined', () => {
    const adapter = new TestableOpenAIMessageAdapter()
    const request = {
      model: 'qwen3-max',
      messages: [{ role: 'user', content: 'hello' }],
      enable_thinking: undefined,
    } as LLMRequestNonStreaming & Record<string, unknown>

    const params = adapter.buildChatCompletionCreateParamsForTest(request)
    const record = params as unknown as Record<string, unknown>

    expect(record).not.toHaveProperty('enable_thinking')
  })
})
