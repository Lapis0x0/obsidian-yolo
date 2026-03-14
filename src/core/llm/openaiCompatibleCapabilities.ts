import { ChatModel } from '../../types/chat-model.types'

type OpenAICompatibleModel = Extract<
  ChatModel,
  { providerType: 'openai-compatible' }
>

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

type OpenAICompatibleRequestRecord = Record<string, unknown>

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
    // Some OpenAI-compatible backends reject stream_options.
    disableStreamOptions: host === 'api.mistral.ai',
    reasoningMode: 'openai',
  }
}

export function applyOpenAICompatibleCapabilities(params: {
  request: OpenAICompatibleRequestRecord
  model: OpenAICompatibleModel
  baseUrl?: string
}): void {
  const { request, model, baseUrl } = params
  const capabilities = resolveOpenAICompatibleHostCapabilities(baseUrl)

  if (capabilities.disableStreamOptions) {
    request.stream_options = undefined
  }

  if (model.reasoning?.enabled) {
    const effort = model.reasoning.reasoning_effort
    if (effort) {
      request.reasoning_effort = effort
      request.reasoning = { effort }
    }
  }

  if (!model.thinking) {
    return
  }

  const isEnabled = model.thinking.enabled !== false
  const budget = model.thinking.thinking_budget

  switch (capabilities.reasoningMode) {
    case 'dashscope': {
      request.enable_thinking = isEnabled
      if (typeof budget === 'number' && budget >= 0) {
        request.thinking_budget = budget
      }
      return
    }
    case 'intern': {
      request.thinking_mode = isEnabled
      return
    }
    case 'siliconflow': {
      request.enable_thinking = isEnabled
      return
    }
    case 'volcengine': {
      request.thinking = {
        type: isEnabled ? 'enabled' : 'disabled',
      }
      return
    }
    case 'openai':
    default: {
      if (isEnabled) {
        request.thinking_config = {
          thinking_budget: budget,
          include_thoughts: true,
        }
        request.thinkingConfig = {
          thinkingBudget: budget,
          includeThoughts: true,
        }
      } else {
        request.reasoning = {
          ...(typeof request.reasoning === 'object' &&
          request.reasoning !== null
            ? (request.reasoning as Record<string, unknown>)
            : {}),
          max_tokens: 0,
          exclude: true,
        }
      }
      return
    }
  }
}
