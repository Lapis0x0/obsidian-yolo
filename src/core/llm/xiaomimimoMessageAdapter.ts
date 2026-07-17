import { ChatCompletionMessageParam } from 'openai/resources/chat/completions'

import { RequestMessage } from '../../types/llm/request'

import { OpenAIMessageAdapter } from './openaiMessageAdapter'

/**
 * Adapter for Xiaomi MiMo. Only the request side is customized: assistant
 * messages must carry `reasoning_content` back to the server when thinking
 * mode is on, otherwise the API returns 400 for any later assistant turn
 * that includes tool_calls (see
 * https://platform.xiaomimimo.com/docs/zh-CN/usage-guide/passing-back-reasoning_content).
 *
 * Response parsing is delegated to the OpenAI base adapter, which already
 * extracts `reasoning_content` (and legacy `reasoning` / `reasoning_details`)
 * plus normalizes tool-call / function-call shapes — re-implementing it here
 * would silently drop those compatibility paths.
 *
 * `typeof === 'string'` (not truthy) so empty-string reasoning is preserved
 * verbatim: stripping it would change the message shape the server already
 * accepted, which is exactly the failure mode the docs warn about.
 */
export class XiaomimimoMessageAdapter extends OpenAIMessageAdapter {
  protected override readonly adapterName = 'Xiaomi MiMo'

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
