// These types are based on the OpenRouter API specification
// https://openrouter.ai/docs/api-reference/overview#responses

export type LLMResponseBase = {
  id: string
  created?: number
  model: string
  system_fingerprint?: string
  usage?: ResponseUsage
}

export type LLMResponseNonStreaming = LLMResponseBase & {
  choices: NonStreamingChoice[]
  object: 'chat.completion'
}

export type LLMResponseStreaming = LLMResponseBase & {
  choices: StreamingChoice[]
  object: 'chat.completion.chunk'
}

export type LLMResponse = LLMResponseNonStreaming | LLMResponseStreaming

export type ResponseUsage = {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  /**
   * Input tokens served from an ephemeral prompt cache (Anthropic only, for now).
   * Included inside `prompt_tokens`; exposed separately for cost/hit-rate display.
   */
  cache_read_input_tokens?: number
  /**
   * Input tokens written to the ephemeral prompt cache this request (Anthropic only).
   * Included inside `prompt_tokens`; carries a write premium on the bill.
   */
  cache_creation_input_tokens?: number
}

export type GeminiAssistantPart =
  | {
      type: 'text'
      text: string
      thought?: boolean
      thoughtSignature?: string
    }
  | {
      type: 'functionCall'
      id?: string
      name: string
      args?: Record<string, unknown>
      thoughtSignature?: string
    }

export type ProviderMetadata = {
  gemini?: {
    parts: GeminiAssistantPart[]
  }
}

type NonStreamingChoice = {
  finish_reason: string | null // Depends on the model. Ex: 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'function_call'
  message: {
    content: string | null
    reasoning?: string | null
    role: string
    annotations?: Annotation[]
    tool_calls?: ToolCall[]
    providerMetadata?: ProviderMetadata
  }
  error?: Error
}

type StreamingChoice = {
  finish_reason: string | null
  delta: {
    content?: string | null
    reasoning?: string | null
    role?: string
    annotations?: Annotation[]
    tool_calls?: ToolCallDelta[]
    providerMetadata?: ProviderMetadata
  }
  error?: Error
}

// Following annotation schema from OpenAI: https://platform.openai.com/docs/guides/tools-web-search#output-and-citations
export type Annotation = {
  type: 'url_citation'
  url_citation: {
    url: string
    title?: string
    start_index?: number
    end_index?: number
  }
}

type Error = {
  code: number // See "Error Handling" section
  message: string
}

export type ToolCall = {
  id?: string
  type: 'function'
  metadata?: {
    thoughtSignature?: string
  }
  function: {
    arguments?: string
    name: string
  }
}

export type ToolCallDelta = {
  index: number
  id?: string
  type?: 'function'
  metadata?: {
    thoughtSignature?: string
  }
  function?: {
    arguments?: string
    name?: string
  }
}
