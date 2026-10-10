/**
 * What a Copilot model request says about itself, read from its HTTP body.
 *
 * Copilot bills a premium request per user turn: `X-Initiator: user` counts
 * one, `agent` marks the follow-up turns an agent makes on its own (feeding
 * tool results back). `Copilot-Vision-Request` must be set whenever the
 * request carries an image, or the gateway rejects it.
 */
export type CopilotRequestTraits = {
  initiator: 'user' | 'agent'
  hasImage: boolean
}

/** The three wire formats Copilot serves, named by their endpoint. */
export type CopilotEndpoint = 'chat' | 'responses' | 'messages'

const USER_INITIATED_TRAITS: CopilotRequestTraits = {
  initiator: 'user',
  hasImage: false,
}

type JsonRecord = Record<string, unknown>

const asRecord = (value: unknown): JsonRecord | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null

const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : []

/** Which wire format a request path belongs to, if any. */
export const resolveCopilotEndpointFromPath = (
  pathname: string,
): CopilotEndpoint | null => {
  const path = pathname.replace(/\/+$/, '')
  if (path.endsWith('/chat/completions')) return 'chat'
  if (path.endsWith('/responses')) return 'responses'
  if (path.endsWith('/v1/messages')) return 'messages'
  return null
}

/** True when any content part (or a tool result's content) is `imageType`. */
const contentHasImage = (content: unknown, imageType: string): boolean =>
  asArray(content).some((part) => {
    const record = asRecord(part)
    if (!record) return false
    if (record.type === imageType) return true
    // Anthropic `tool_result` and Responses `function_call_output` nest their
    // own content arrays, which may carry images too.
    return (
      contentHasImage(record.content, imageType) ||
      contentHasImage(record.output, imageType)
    )
  })

const resolveChatTraits = (body: JsonRecord): CopilotRequestTraits => {
  const messages = asArray(body.messages)
  const last = asRecord(messages[messages.length - 1])
  return {
    initiator: !last || last.role === 'user' ? 'user' : 'agent',
    hasImage: messages.some((message) =>
      contentHasImage(asRecord(message)?.content, 'image_url'),
    ),
  }
}

const resolveResponsesTraits = (body: JsonRecord): CopilotRequestTraits => {
  if (typeof body.input === 'string') {
    return USER_INITIATED_TRAITS
  }
  const items = asArray(body.input)
  const last = asRecord(items[items.length - 1])
  return {
    // A trailing `function_call_output` (or any non-user item) is the agent
    // continuing on its own; only a user message starts a new turn.
    initiator: !last || last.role === 'user' ? 'user' : 'agent',
    hasImage: items.some((item) => {
      const record = asRecord(item)
      return (
        !!record &&
        (contentHasImage(record.content, 'input_image') ||
          contentHasImage(record.output, 'input_image'))
      )
    }),
  }
}

const resolveMessagesTraits = (body: JsonRecord): CopilotRequestTraits => {
  const messages = asArray(body.messages)
  const last = asRecord(messages[messages.length - 1])
  // Anthropic carries tool results as a `user` message, so the role alone
  // cannot tell a tool continuation from a new user turn: it is a user turn
  // only when the message holds something other than `tool_result` blocks.
  const lastIsUserTurn =
    !last ||
    (last.role === 'user' &&
      (!Array.isArray(last.content) ||
        last.content.length === 0 ||
        !last.content.every(
          (block) => asRecord(block)?.type === 'tool_result',
        )))
  return {
    initiator: lastIsUserTurn ? 'user' : 'agent',
    hasImage: messages.some((message) =>
      contentHasImage(asRecord(message)?.content, 'image'),
    ),
  }
}

/**
 * Reads the traits from a serialized request body. A body that cannot be
 * parsed counts as a user turn: billing a turn is the safe misjudgement,
 * marking a real user turn as `agent` would misreport usage.
 */
export const resolveCopilotRequestTraits = (
  endpoint: CopilotEndpoint,
  bodyText: string | undefined,
): CopilotRequestTraits => {
  if (!bodyText) {
    return USER_INITIATED_TRAITS
  }
  let body: JsonRecord | null
  try {
    body = asRecord(JSON.parse(bodyText))
  } catch {
    return USER_INITIATED_TRAITS
  }
  if (!body) {
    return USER_INITIATED_TRAITS
  }
  switch (endpoint) {
    case 'chat':
      return resolveChatTraits(body)
    case 'responses':
      return resolveResponsesTraits(body)
    case 'messages':
      return resolveMessagesTraits(body)
  }
}
