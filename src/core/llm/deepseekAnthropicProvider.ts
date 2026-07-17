import {
  ContentBlockParam,
  MessageParam,
} from '@anthropic-ai/sdk/resources/messages'

import { RequestMessage } from '../../types/llm/request'
import { LLMProvider } from '../../types/provider.types'
import { resolveDeepSeekAnthropicBaseUrl } from '../../utils/llm/provider-base-url'

import { AnthropicProvider } from './anthropic'

// DeepSeek 的 Anthropic 兼容端点在 thinking 模式 + tool_use 时，要求上一轮
// 的 thinking block 必须随 assistant message 回传；与 Kimi 类似，它不校验
// signature 真实性，只要 thinking block 存在即可，这里沿用占位符。
const PLACEHOLDER_SIGNATURE = 'c2lnbmF0dXJlX3BsYWNlaG9sZGVy'

export { resolveDeepSeekAnthropicBaseUrl }

export class DeepSeekAnthropicProvider extends AnthropicProvider {
  constructor(
    provider: LLMProvider,
    options?: ConstructorParameters<typeof AnthropicProvider>[1],
  ) {
    super(
      {
        ...provider,
        baseUrl: resolveDeepSeekAnthropicBaseUrl(provider.baseUrl),
      },
      options,
    )
  }

  protected parseRequestMessage(message: RequestMessage): MessageParam | null {
    const parsed = super.parseRequestMessage(message)
    if (
      !parsed ||
      parsed.role !== 'assistant' ||
      message.role !== 'assistant'
    ) {
      return parsed
    }

    const blocks = parsed.content as ContentBlockParam[]
    const hasToolUse = blocks.some((b) => b.type === 'tool_use')
    if (!hasToolUse) {
      return parsed
    }

    const reasoning =
      typeof message.reasoning === 'string' ? message.reasoning : ''

    const thinkingBlock: ContentBlockParam = {
      type: 'thinking',
      thinking: reasoning,
      signature: PLACEHOLDER_SIGNATURE,
    }

    return {
      role: 'assistant',
      content: [thinkingBlock, ...blocks],
    }
  }
}
