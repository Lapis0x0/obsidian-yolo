type ResponseFormatErrorOptions = {
  adapter: string
  stage: string
  expected: string
  response: unknown
}

export type LLMResponseFormatErrorPayload = {
  kind: 'llm_response_format_error'
  adapter: string
  stage: string
  expected: string
  problem:
    | {
        type: 'response_not_object'
        actualType: string
      }
    | {
        type: 'missing_choices'
      }
    | {
        type: 'invalid_choices'
        actualType: string
      }
  responseKeys?: string[]
  upstreamError?: {
    message?: string
    type?: string
    code?: string
  }
  upstreamMessage?: string
  preview?: string
}

const MAX_PREVIEW_LENGTH = 600
const MAX_ARRAY_PREVIEW_ITEMS = 3
const MAX_OBJECT_PREVIEW_KEYS = 12
const MAX_PREVIEW_DEPTH = 4
const SERIALIZED_ERROR_PREFIX = 'YOLO_LLM_RESPONSE_FORMAT_ERROR:'

const SENSITIVE_KEY_PATTERN =
  /authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|cookie/i

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object'

const describeValue = (value: unknown): string => {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array(${value.length})`
  return typeof value
}

const getResponseKeys = (response: unknown): string[] | undefined => {
  if (!isRecord(response)) {
    return undefined
  }
  const keys = Object.keys(response)
  return keys.length > 0 ? keys.slice(0, MAX_OBJECT_PREVIEW_KEYS) : undefined
}

const sanitizeForPreview = (value: unknown, depth = 0): unknown => {
  if (depth > MAX_PREVIEW_DEPTH) {
    return '[truncated]'
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_PREVIEW_ITEMS)
      .map((item) => sanitizeForPreview(item, depth + 1))
  }

  if (!isRecord(value)) {
    return value
  }

  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value).slice(
    0,
    MAX_OBJECT_PREVIEW_KEYS,
  )) {
    result[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? '[redacted]'
      : sanitizeForPreview(child, depth + 1)
  }
  return result
}

const stringifyPreview = (response: unknown): string | null => {
  try {
    const preview = JSON.stringify(sanitizeForPreview(response))
    if (!preview) {
      return null
    }
    return preview.length > MAX_PREVIEW_LENGTH
      ? `${preview.slice(0, MAX_PREVIEW_LENGTH)}...`
      : preview
  } catch {
    return null
  }
}

const readStringField = (
  value: Record<string, unknown>,
  key: string,
): string | undefined => {
  const field = value[key]
  return typeof field === 'string' && field.trim().length > 0
    ? field.trim()
    : undefined
}

const extractUpstreamError = (
  response: unknown,
): Pick<LLMResponseFormatErrorPayload, 'upstreamError' | 'upstreamMessage'> => {
  if (!isRecord(response)) {
    return {}
  }

  const error = response.error
  if (typeof error === 'string' && error.trim().length > 0) {
    return {
      upstreamError: {
        message: error.trim(),
      },
    }
  }

  if (isRecord(error)) {
    const message = readStringField(error, 'message')
    const type = readStringField(error, 'type')
    const code =
      readStringField(error, 'code') ??
      (typeof error.code === 'number' ? String(error.code) : undefined)

    return message || type || code
      ? {
          upstreamError: {
            ...(message ? { message } : {}),
            ...(type ? { type } : {}),
            ...(code ? { code } : {}),
          },
        }
      : {}
  }

  const message = readStringField(response, 'message')
  return message ? { upstreamMessage: message } : {}
}

const describeProblem = (
  response: unknown,
): LLMResponseFormatErrorPayload['problem'] => {
  if (!isRecord(response)) {
    return {
      type: 'response_not_object',
      actualType: describeValue(response),
    }
  }

  if (!Object.prototype.hasOwnProperty.call(response, 'choices')) {
    return {
      type: 'missing_choices',
    }
  }

  return {
    type: 'invalid_choices',
    actualType: describeValue(response.choices),
  }
}

const buildResponseFormatErrorPayload = ({
  adapter,
  stage,
  expected,
  response,
}: ResponseFormatErrorOptions): LLMResponseFormatErrorPayload => {
  const preview = stringifyPreview(response)
  const responseKeys = getResponseKeys(response)
  return {
    kind: 'llm_response_format_error',
    adapter,
    stage,
    expected,
    problem: describeProblem(response),
    ...(responseKeys ? { responseKeys } : {}),
    ...extractUpstreamError(response),
    ...(preview ? { preview } : {}),
  }
}

const serializeResponseFormatErrorPayload = (
  payload: LLMResponseFormatErrorPayload,
): string => {
  return `${SERIALIZED_ERROR_PREFIX}${JSON.stringify(payload)}`
}

export class LLMResponseFormatError extends Error {
  readonly adapter: string
  readonly stage: string
  readonly expected: string
  readonly payload: LLMResponseFormatErrorPayload

  constructor(options: ResponseFormatErrorOptions) {
    const payload = buildResponseFormatErrorPayload(options)
    super(serializeResponseFormatErrorPayload(payload))
    this.name = 'LLMResponseFormatError'
    this.adapter = options.adapter
    this.stage = options.stage
    this.expected = options.expected
    this.payload = payload
  }
}

export function parseLLMResponseFormatError(
  message: string,
): LLMResponseFormatErrorPayload | null {
  if (!message.startsWith(SERIALIZED_ERROR_PREFIX)) {
    return null
  }

  try {
    const parsed = JSON.parse(message.slice(SERIALIZED_ERROR_PREFIX.length))
    if (
      isRecord(parsed) &&
      parsed.kind === 'llm_response_format_error' &&
      typeof parsed.adapter === 'string' &&
      typeof parsed.stage === 'string' &&
      typeof parsed.expected === 'string' &&
      isRecord(parsed.problem)
    ) {
      return parsed as LLMResponseFormatErrorPayload
    }
  } catch {
    return null
  }

  return null
}

export function requireResponseChoicesArray<T>(
  response: unknown,
  options: Omit<ResponseFormatErrorOptions, 'response' | 'expected'>,
): T[] {
  if (isRecord(response) && Array.isArray(response.choices)) {
    return response.choices as T[]
  }

  throw new LLMResponseFormatError({
    ...options,
    expected: 'choices_array',
    response,
  })
}
