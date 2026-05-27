const MAX_ERROR_CAUSE_DEPTH = 6

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object'

const readMessage = (error: unknown): string | null => {
  if (typeof error === 'string') {
    return error.trim() || null
  }

  if (error instanceof Error) {
    return error.message.trim() || error.name || null
  }

  if (isRecord(error) && typeof error.message === 'string') {
    return error.message.trim() || null
  }

  if (error === undefined || error === null) {
    return null
  }

  if (typeof error === 'object') {
    try {
      return JSON.stringify(error).trim() || null
    } catch {
      return null
    }
  }

  switch (typeof error) {
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(error).trim() || null
    case 'symbol':
      return error.toString().trim() || null
    case 'function':
      return error.name.trim() || error.toString().trim() || null
    default:
      return null
  }
}

const collectErrorMessages = (
  error: unknown,
  seen: Set<unknown>,
  depth: number,
): string[] => {
  if (depth > MAX_ERROR_CAUSE_DEPTH || error === undefined || error === null) {
    return []
  }
  if (
    (typeof error === 'object' || typeof error === 'function') &&
    seen.has(error)
  ) {
    return []
  }
  if (typeof error === 'object' || typeof error === 'function') {
    seen.add(error)
  }

  const messages: string[] = []
  const message = readMessage(error)
  if (message) {
    messages.push(message)
  }

  if (isRecord(error)) {
    const nestedCandidates = [error.cause, error.rawError, error.error]
    for (const nested of nestedCandidates) {
      messages.push(...collectErrorMessages(nested, seen, depth + 1))
    }
  }

  return messages
}

export function formatErrorMessageWithCauses(
  error: unknown,
  fallback = 'Unknown error',
): string {
  const seenMessages = new Set<string>()
  const messages = collectErrorMessages(error, new Set<unknown>(), 0).filter(
    (message) => {
      if (seenMessages.has(message)) {
        return false
      }
      seenMessages.add(message)
      return true
    },
  )

  if (messages.length === 0) {
    return fallback
  }

  const [primary, ...causes] = messages
  if (!primary) {
    return fallback
  }
  if (causes.length === 0) {
    return primary
  }

  return [primary, ...causes.map((message) => `Caused by: ${message}`)].join(
    '\n',
  )
}
