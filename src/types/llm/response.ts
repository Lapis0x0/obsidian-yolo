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

/**
 * A search the provider ran on its own servers. There is no tool call for the
 * agent to execute — this is the receipt of work already done, carried through
 * so the UI can show what was searched and which pages came back.
 */
export type HostedWebSearchCall = {
  id: string
  query?: string
  results: { title?: string; url: string }[]
}

/**
 * A tool the provider ran inside its own runtime. There is no tool call for
 * the agent to execute — this is the receipt of work already done, carried
 * through so the UI can show what the provider did on the user's behalf.
 *
 * Unlike `HostedWebSearchCall`, which the provider attaches to the response as
 * a whole, a run of these happens *somewhere* in the response: text before it
 * and text after it are separate parts of the answer. It therefore travels as
 * a positional signal on the stream — see `providerToolRun` — not as metadata
 * on the finished message, which could only ever be rendered in one fixed
 * place.
 */
export type ProviderExecutedToolCall = {
  id: string
  name: string
  /** Raw tool input as the provider's runtime reported it. */
  input?: Record<string, unknown>
  /**
   * `running` until the provider's runtime reports the tool finished. A turn
   * that ends with calls still `running` was interrupted.
   */
  status: 'running' | 'success' | 'error'
  /** Result the provider's runtime fed back to its own model, if reported. */
  resultText?: string
}

export type ProviderMetadata = {
  gemini?: {
    parts: GeminiAssistantPart[]
  }
  hostedWebSearch?: HostedWebSearchCall[]
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
    /**
     * One run of tools the provider executed itself, at this point in the
     * stream. Every chunk carries the run's full call list, so the latest
     * value supersedes; the run is identified by its first call's id, and a
     * run id not seen before opens a new one.
     *
     * Receiving a run splits the assistant message: what streamed before it
     * is one message, the run is a tool message of its own, and what streams
     * after starts a new message. That is what puts the tool cards between
     * the two halves of the answer instead of ahead of both.
     */
    providerToolRun?: ProviderExecutedToolCall[]
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
