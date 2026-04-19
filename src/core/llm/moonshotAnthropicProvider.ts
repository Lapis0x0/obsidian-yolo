import {
  ContentBlockParam,
  MessageParam,
} from '@anthropic-ai/sdk/resources/messages'

import { RequestMessage } from '../../types/llm/request'

import { AnthropicProvider } from './anthropic'

// Kimi 的 Anthropic 兼容端点不校验 thinking block 的 signature 真实性，
// 只要求 thinking block 存在；这里复用社区代理 (abcpro1/kimi-proxy) 的占位符。
const PLACEHOLDER_SIGNATURE = 'c2lnbmF0dXJlX3BsYWNlaG9sZGVy'

export class MoonshotAnthropicProvider extends AnthropicProvider {
  protected parseRequestMessage(
    message: RequestMessage,
  ): MessageParam | null {
    const parsed = super.parseRequestMessage(message)
    if (!parsed || parsed.role !== 'assistant' || message.role !== 'assistant') {
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
