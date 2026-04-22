import {
  REASONING_META,
  type ReasoningLevel,
  type ReasoningModelType,
} from '../../types/reasoning'

type OpenAICompatibleRequestRecord = Record<string, unknown>

type OpenAICompatibleHostCapabilities = {
  host: string | null
  disableStreamOptions: boolean
  reasoningMode:
    | 'openai'
    | 'dashscope'
    | 'volcengine'
    | 'intern'
    | 'siliconflow'
}

const VOLCENGINE_REASONING_HOSTS = new Set([
  'ark.cn-beijing.volces.com',
  'open.bigmodel.cn',
  'api.moonshot.cn',
])

function getHost(baseUrl?: string): string | null {
  if (!baseUrl || baseUrl.trim().length === 0) {
    return null
  }

  try {
    const parsed = new URL(baseUrl)
    return parsed.host.toLowerCase()
  } catch {
    return null
  }
}

export function resolveOpenAICompatibleHostCapabilities(
  baseUrl?: string,
): OpenAICompatibleHostCapabilities {
  const host = getHost(baseUrl)

  if (host === 'dashscope.aliyuncs.com') {
    return {
      host,
      disableStreamOptions: false,
      reasoningMode: 'dashscope',
    }
  }

  if (host === 'chat.intern-ai.org.cn') {
    return {
      host,
      disableStreamOptions: false,
      reasoningMode: 'intern',
    }
  }

  if (host === 'api.siliconflow.cn') {
    return {
      host,
      disableStreamOptions: false,
      reasoningMode: 'siliconflow',
    }
  }

  if (host && VOLCENGINE_REASONING_HOSTS.has(host)) {
    return {
      host,
      disableStreamOptions: false,
      reasoningMode: 'volcengine',
    }
  }

  return {
    host,
    disableStreamOptions: host === 'api.mistral.ai',
    reasoningMode: 'openai',
  }
}

export function applyOpenAICompatibleCapabilities(params: {
  request: OpenAICompatibleRequestRecord
  reasoningType?: ReasoningModelType
  reasoningLevel?: ReasoningLevel
  baseUrl?: string
}): void {
  const { request, reasoningType, reasoningLevel, baseUrl } = params
  const capabilities = resolveOpenAICompatibleHostCapabilities(baseUrl)

  if (capabilities.disableStreamOptions) {
    request.stream_options = undefined
  }

  if (capabilities.host === 'api.mistral.ai') {
    return
  }

  if (
    !reasoningLevel ||
    !reasoningType ||
    reasoningType === 'none'
  ) {
    return
  }

  switch (capabilities.reasoningMode) {
    case 'dashscope': {
      if (reasoningLevel === 'off') {
        request.enable_thinking = false
        return
      }
      request.enable_thinking = true
      if (reasoningLevel === 'auto') {
        request.thinking_budget = -1
        return
      }
      request.thinking_budget = REASONING_META[reasoningLevel].budget
      return
    }
    case 'intern': {
      request.thinking_mode = reasoningLevel !== 'off'
      return
    }
    case 'siliconflow': {
      request.enable_thinking = reasoningLevel !== 'off'
      return
    }
    case 'volcengine': {
      request.thinking = {
        type: reasoningLevel === 'off' ? 'disabled' : 'enabled',
      }
      return
    }
    case 'openai':
    default: {
      if (reasoningType === 'openai') {
        if (reasoningLevel === 'auto') {
          return
        }
        const effort =
          reasoningLevel === 'off'
            ? 'low'
            : REASONING_META[reasoningLevel].effort
        request.reasoning_effort = effort
        request.reasoning = { effort }
        return
      }

      if (reasoningLevel === 'auto') {
        request.thinking_config = {
          thinking_budget: -1,
          include_thoughts: true,
        }
        request.thinkingConfig = {
          thinkingBudget: -1,
          includeThoughts: true,
        }
        return
      }

      if (reasoningLevel === 'off') {
        request.reasoning = {
          ...(typeof request.reasoning === 'object' &&
          request.reasoning !== null
            ? (request.reasoning as Record<string, unknown>)
            : {}),
          max_tokens: 0,
          exclude: true,
        }
        return
      }

      const budget = REASONING_META[reasoningLevel].budget
      request.thinking_config = {
        thinking_budget: budget,
        include_thoughts: true,
      }
      request.thinkingConfig = {
        thinkingBudget: budget,
        includeThoughts: true,
      }
      return
    }
  }
}
