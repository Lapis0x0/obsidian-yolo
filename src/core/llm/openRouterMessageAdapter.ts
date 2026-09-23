import {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions'

import { RequestMessage } from '../../types/llm/request'
import {
  LLMResponseNonStreaming,
  LLMResponseStreaming,
  OpenRouterReasoningDetail,
} from '../../types/llm/response'

import { OpenAIMessageAdapter } from './openaiMessageAdapter'

const readReasoningDetails = (
  source: unknown,
): OpenRouterReasoningDetail[] | undefined => {
  const details = (source as { reasoning_details?: unknown } | undefined)
    ?.reasoning_details
  return Array.isArray(details) && details.length > 0
    ? (details as OpenRouterReasoningDetail[])
    : undefined
}

/**
 * Streamed `reasoning_details` arrive as fragments of the same block (same
 * `index`): the text pieces concatenate, the other fields (signature, id,
 * format) are whatever the latest fragment carries.
 */
const TEXT_FIELDS = ['text', 'summary'] as const

const accumulateReasoningDetails = (
  blocks: OpenRouterReasoningDetail[],
  fragments: OpenRouterReasoningDetail[],
): void => {
  for (const fragment of fragments) {
    const position =
      typeof fragment.index === 'number'
        ? blocks.findIndex((block) => block.index === fragment.index)
        : -1
    if (position === -1) {
      blocks.push({ ...fragment })
      continue
    }
    const block = blocks[position]
    const merged: OpenRouterReasoningDetail = { ...block, ...fragment }
    for (const field of TEXT_FIELDS) {
      if (
        typeof block[field] === 'string' &&
        typeof fragment[field] === 'string'
      ) {
        merged[field] = block[field] + fragment[field]
      }
    }
    blocks[position] = merged
  }
}

/**
 * OpenRouter returns the upstream model's reasoning as `reasoning_details`
 * blocks (plain, summarized, or encrypted, some signed). They are kept as
 * returned and sent back on the assistant message, which is how signed or
 * encrypted reasoning reaches the upstream model again.
 */
export class OpenRouterMessageAdapter extends OpenAIMessageAdapter {
  protected override readonly adapterName = 'OpenRouter'

  protected override parseRequestMessage(
    message: RequestMessage,
  ): ChatCompletionMessageParam {
    const parsed = super.parseRequestMessage(
      message,
    ) as ChatCompletionMessageParam & {
      reasoning_details?: OpenRouterReasoningDetail[]
    }
    if (message.role === 'assistant' && message.providerMetadata?.openrouter) {
      parsed.reasoning_details =
        message.providerMetadata.openrouter.reasoningDetails
    }
    return parsed
  }

  protected override parseNonStreamingResponse(
    response: ChatCompletion,
  ): LLMResponseNonStreaming {
    const parsed = super.parseNonStreamingResponse(response)
    return {
      ...parsed,
      choices: parsed.choices.map((choice, i) => {
        const reasoningDetails = readReasoningDetails(
          response.choices[i]?.message,
        )
        return reasoningDetails
          ? {
              ...choice,
              message: {
                ...choice.message,
                providerMetadata: {
                  ...choice.message.providerMetadata,
                  openrouter: { reasoningDetails },
                },
              },
            }
          : choice
      }),
    }
  }

  protected override async *streamResponseGenerator(
    stream: AsyncIterable<ChatCompletionChunk>,
  ): AsyncIterable<LLMResponseStreaming> {
    const blocks: OpenRouterReasoningDetail[] = []
    async function* collect() {
      for await (const chunk of stream) {
        const fragments = readReasoningDetails(chunk.choices?.[0]?.delta)
        if (fragments) accumulateReasoningDetails(blocks, fragments)
        yield chunk
      }
    }

    for await (const chunk of super.streamResponseGenerator(collect())) {
      const choice = chunk.choices[0]
      // The reasoning is complete once the reply finishes; hand it over in
      // one piece there, since streamed metadata replaces, not merges.
      if (blocks.length > 0 && choice?.finish_reason) {
        yield {
          ...chunk,
          choices: [
            {
              ...choice,
              delta: {
                ...choice.delta,
                providerMetadata: {
                  ...choice.delta.providerMetadata,
                  openrouter: { reasoningDetails: [...blocks] },
                },
              },
            },
            ...chunk.choices.slice(1),
          ],
        }
        continue
      }
      yield chunk
    }
  }
}
