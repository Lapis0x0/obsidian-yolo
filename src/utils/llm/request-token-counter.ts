import { RequestMessage } from '../../types/llm/request'
import { yieldToMain } from '../common/yield-to-main'

import { tokenCount } from './token'

const TOKEN_COUNT_SLICE_SIZE = 4000

type CountRequestPromptTokensOptions = {
  signal?: AbortSignal
}

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) {
    throw new DOMException('Token counting aborted', 'AbortError')
  }
}

const countTextTokensChunked = async (
  text: string,
  options: CountRequestPromptTokensOptions,
): Promise<number> => {
  if (!text) return 0

  let total = 0
  for (let index = 0; index < text.length; index += TOKEN_COUNT_SLICE_SIZE) {
    throwIfAborted(options.signal)
    const slice = text.slice(index, index + TOKEN_COUNT_SLICE_SIZE)
    total += await tokenCount(slice)
    await yieldToMain()
  }
  return total
}

export async function countRequestPromptTokens(
  requestMessages: RequestMessage[],
  options: CountRequestPromptTokensOptions = {},
): Promise<number> {
  let total = 0

  for (const message of requestMessages) {
    throwIfAborted(options.signal)
    total += await countTextTokensChunked(message.role, options)

    if (typeof message.content === 'string') {
      total += await countTextTokensChunked(message.content, options)
      continue
    }

    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        throwIfAborted(options.signal)
        if (part.type === 'text') {
          total += await countTextTokensChunked(part.text, options)
          continue
        }
        if (part.type === 'image_url') {
          total += await countTextTokensChunked(part.image_url.url, options)
        }
      }
    }
  }

  return total
}
