import type {
  CacheControlEphemeral,
  ContentBlockParam,
  MessageParam,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/messages'

const EPHEMERAL: CacheControlEphemeral = { type: 'ephemeral' }

function addCacheControlToSystem(
  system: unknown,
): string | TextBlockParam[] | undefined {
  if (system === undefined || system === null) return undefined
  if (typeof system === 'string') {
    if (system.trim().length === 0) return system
    return [{ type: 'text', text: system, cache_control: EPHEMERAL }]
  }
  if (!Array.isArray(system) || system.length === 0) {
    return system as TextBlockParam[] | undefined
  }
  const lastIdx = system.length - 1
  return (system as TextBlockParam[]).map((block, i) =>
    i === lastIdx ? { ...block, cache_control: EPHEMERAL } : block,
  )
}

function addCacheControlToTools(
  tools: unknown,
): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tools) || tools.length === 0) {
    return tools as Array<Record<string, unknown>> | undefined
  }
  const lastIdx = tools.length - 1
  return (tools as Array<Record<string, unknown>>).map((tool, i) =>
    i === lastIdx ? { ...tool, cache_control: EPHEMERAL } : tool,
  )
}

function addCacheControlToMessageTail(message: MessageParam): MessageParam {
  const { content } = message
  if (typeof content === 'string') {
    if (content.length === 0) return message
    return {
      ...message,
      content: [{ type: 'text', text: content, cache_control: EPHEMERAL }],
    }
  }
  if (!Array.isArray(content) || content.length === 0) return message
  const lastIdx = content.length - 1
  const nextContent = content.map((block, i) => {
    if (i !== lastIdx) return block
    return { ...block, cache_control: EPHEMERAL } as ContentBlockParam
  })
  return { ...message, content: nextContent }
}

/**
 * Apply Anthropic ephemeral prompt caching breakpoints (up to 4) on a
 * Messages API payload:
 *   1. Last text block of `system`
 *   2. Last entry of `tools`
 *   3. Last content block of `messages[len-2]`  (stable across volatile tail changes,
 *      e.g. an auto-appended current-file user message)
 *   4. Last content block of `messages[len-1]`  (rolling tail — extends cache across
 *      agent loop iterations that append assistant/tool turns)
 *
 * Non-mutating: returns a shallow-cloned payload with breakpoints injected.
 */
export function applyAnthropicPromptCache<
  T extends { messages: MessageParam[] },
>(payload: T): T {
  const p = payload as T & {
    system?: unknown
    tools?: unknown
  }
  const system = addCacheControlToSystem(p.system)
  const tools = addCacheControlToTools(p.tools)

  const messages = payload.messages
  let nextMessages: MessageParam[] = messages
  if (messages.length >= 1) {
    const lastIdx = messages.length - 1
    nextMessages = messages.map((m, i) =>
      i === lastIdx ? addCacheControlToMessageTail(m) : m,
    )
    if (messages.length >= 2) {
      const secondLastIdx = lastIdx - 1
      nextMessages = nextMessages.map((m, i) =>
        i === secondLastIdx ? addCacheControlToMessageTail(m) : m,
      )
    }
  }

  return {
    ...payload,
    ...(p.system !== undefined && system !== undefined ? { system } : {}),
    ...(p.tools !== undefined && tools !== undefined ? { tools } : {}),
    messages: nextMessages,
  } as T
}
