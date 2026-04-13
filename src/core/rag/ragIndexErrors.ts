import {
  LLMAPIKeyInvalidException,
  LLMAPIKeyNotSetException,
  LLMBaseUrlNotSetException,
  LLMRateLimitExceededException,
} from '../llm/exception'

export type RagIndexFailureKind =
  | 'transient'
  | 'permanent'
  | 'aborted'
  | 'unknown'

const TRANSIENT_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504])
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
])

const messageIncludesAny = (message: string, patterns: string[]): boolean =>
  patterns.some((pattern) => message.includes(pattern))

export const isAbortLikeError = (error: unknown): boolean => {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true
  }
  if (!(error instanceof Error)) {
    return false
  }
  return error.name === 'AbortError'
}

export const classifyRagIndexError = (error: unknown): RagIndexFailureKind => {
  if (isAbortLikeError(error)) {
    return 'aborted'
  }

  if (
    error instanceof LLMAPIKeyNotSetException ||
    error instanceof LLMAPIKeyInvalidException ||
    error instanceof LLMBaseUrlNotSetException
  ) {
    return 'permanent'
  }

  const status =
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status?: unknown }).status === 'number'
      ? (error as { status: number }).status
      : undefined

  if (status !== undefined) {
    if (TRANSIENT_STATUS_CODES.has(status)) {
      return 'transient'
    }
    if (status >= 400 && status < 500) {
      return 'permanent'
    }
  }

  if (error instanceof LLMRateLimitExceededException) {
    return 'transient'
  }

  const code =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : undefined

  if (code && TRANSIENT_ERROR_CODES.has(code.toUpperCase())) {
    return 'transient'
  }

  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase()

  if (
    messageIncludesAny(message, [
      'rate limit',
      'timeout',
      'timed out',
      'temporarily unavailable',
      'fetch failed',
      'network',
      'socket hang up',
      'connection reset',
      'connection lost',
      'service unavailable',
      'too many requests',
      'overloaded',
    ])
  ) {
    return 'transient'
  }

  return 'unknown'
}

export const isTransientRagIndexError = (error: unknown): boolean =>
  classifyRagIndexError(error) === 'transient'
