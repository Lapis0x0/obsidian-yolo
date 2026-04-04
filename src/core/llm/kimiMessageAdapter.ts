import { ChatCompletionMessageParam } from 'openai/resources/chat/completions'

import { RequestMessage } from '../../types/llm/request'

import { OpenAIMessageAdapter } from './openaiMessageAdapter'

export class KimiMessageAdapter extends OpenAIMessageAdapter {
  protected parseRequestMessage(
    message: RequestMessage,
  ): ChatCompletionMessageParam {
    const parsed = super.parseRequestMessage(
      message,
    ) as ChatCompletionMessageParam & {
      content?: string | null
      tool_calls?: unknown[]
      reasoning_content?: string
    }

    if (message.role !== 'assistant') {
      return parsed
    }

    if (
      Array.isArray(parsed.tool_calls) &&
      parsed.tool_calls.length > 0 &&
      typeof parsed.content === 'string' &&
      parsed.content.length === 0
    ) {
      // Kimi rejects assistant tool-call messages when content is empty.
      parsed.content = ' '
    }

    if (typeof message.reasoning === 'string' && message.reasoning.length > 0) {
      parsed.reasoning_content = message.reasoning
    }

    return parsed
  }
}
