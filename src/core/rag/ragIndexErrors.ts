import { DatabaseSaveFailedError } from '../../database/exception'
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

/**
 * Raised by `embedAndInsertBatches` when one or more files had transient
 * embedding failures and were rolled back to 0 rows. It is always classified
 * as `transient` so the run-level retry path (exponential backoff) is
 * activated — without relying on message-string matching.
 */
export class RagIndexIncompleteError extends Error {
  /** Paths that were rolled back (0 rows) and must be re-embedded next run. */
  readonly rolledBackPaths: string[]

  constructor(rolledBackPaths: string[], message?: string) {
    super(
      message ??
        `Indexing incomplete: ${rolledBackPaths.length} file(s) hit transient embedding failures and were rolled back for retry.`,
    )
    this.name = 'RagIndexIncompleteError'
    this.rolledBackPaths = rolledBackPaths
  }
}

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
  if (error instanceof RagIndexIncompleteError) {
    return 'transient'
  }

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

  // dumpDataDir OOM (#408) and similar persistence failures: classify as
  // permanent so the run records as `failed` and the user sees actionable
  // feedback. Retrying immediately wouldn't help — the snapshot is just as
  // big — and we don't want to thrash an OOM condition with auto-retries.
  if (error instanceof DatabaseSaveFailedError) {
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

export type RagIndexFailureInfo = {
  kind: RagIndexFailureKind
  httpStatus?: number
  message: string
}

const extractStatus = (error: unknown): number | undefined => {
  if (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status?: unknown }).status === 'number'
  ) {
    return (error as { status: number }).status
  }
  return undefined
}

export const describeRagIndexError = (error: unknown): RagIndexFailureInfo => {
  const kind = classifyRagIndexError(error)
  const httpStatus = extractStatus(error)
  const message = error instanceof Error ? error.message : String(error)
  return { kind, httpStatus, message }
}
