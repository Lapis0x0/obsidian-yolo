import { ChatCompletionCreateParamsNonStreaming } from 'openai/resources'
import {
  ChatCompletionContentPart,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions'

import { LLMRequest, RequestMessage } from '../../types/llm/request'
import { filterEmptyAssistantMessages } from '../../utils/chat/tool-boundary'

import { OpenAIMessageAdapter } from './openaiMessageAdapter'

function collapsePureTextContent(
  content: string | Array<ChatCompletionContentPart>,
): string | Array<ChatCompletionContentPart> {
  if (!Array.isArray(content)) {
    return content
  }

  if (
    content.every(
      (part): part is Extract<ChatCompletionContentPart, { type: 'text' }> =>
        part.type === 'text',
    )
  ) {
    return content.map((part) => part.text).join('\n\n')
  }

  return content
}

export class QwenOAuthMessageAdapter extends OpenAIMessageAdapter {
  protected override buildChatCompletionCreateParams(params: {
    request: LLMRequest
    stream: true
  }): ChatCompletionCreateParamsStreaming
  protected override buildChatCompletionCreateParams(params: {
    request: LLMRequest
    stream: false
  }): ChatCompletionCreateParamsNonStreaming
  protected override buildChatCompletionCreateParams({
    request,
    stream,
  }: {
    request: LLMRequest
    stream: boolean
  }):
    | ChatCompletionCreateParamsStreaming
    | ChatCompletionCreateParamsNonStreaming {
    const sanitizedMessages = filterEmptyAssistantMessages(request.messages)

    return {
      model: request.model,
      tools: request.tools,
      tool_choice: request.tool_choice,
      reasoning_effort: request.reasoning_effort,
      web_search_options: request.web_search_options,
      messages: sanitizedMessages.map((message) =>
        this.parseRequestMessage(message),
      ),
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      top_p: request.top_p,
      frequency_penalty: request.frequency_penalty,
      presence_penalty: request.presence_penalty,
      logit_bias: request.logit_bias,
      prediction: request.prediction,
      ...(stream ? { stream: true } : {}),
    }
  }

  protected override parseRequestMessage(
    message: RequestMessage,
  ): ChatCompletionMessageParam {
    const parsed = super.parseRequestMessage(message)

    if (parsed.role === 'user' && Array.isArray(parsed.content)) {
      return {
        ...parsed,
        content: collapsePureTextContent(parsed.content),
      }
    }

    return parsed
  }
}
