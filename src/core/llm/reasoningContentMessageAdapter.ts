import { ChatCompletionMessageParam } from 'openai/resources/chat/completions'

import { RequestMessage } from '../../types/llm/request'

import { OpenAIMessageAdapter } from './openaiMessageAdapter'

/**
 * Adapter for OpenAI-compatible APIs that take the model's reasoning back as
 * `reasoning_content` on assistant messages (Xiaomi MiMo, GLM, Qwen,
 * SiliconFlow). MiMo returns 400 on a later tool-call turn without it; GLM
 * (`clear_thinking: false`) and Qwen (`preserve_thinking: true`) use it to
 * keep reasoning continuous across turns.
 *
 * Response parsing is the base adapter's, which already reads
 * `reasoning_content`. Empty-string reasoning is sent as is, keeping the
 * message shape the server returned.
 */
export class ReasoningContentMessageAdapter extends OpenAIMessageAdapter {
  protected override readonly adapterName: string = 'OpenAI-compatible'

  protected parseRequestMessage(
    message: RequestMessage,
  ): ChatCompletionMessageParam {
    const parsed = super.parseRequestMessage(
      message,
    ) as ChatCompletionMessageParam & {
      reasoning_content?: string
    }

    if (message.role === 'assistant' && typeof message.reasoning === 'string') {
      parsed.reasoning_content = message.reasoning
    }

    return parsed
  }
}
