const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])
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

export class RuntimeComponentRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'RuntimeComponentRequestError'
  }
}

export class RuntimeComponentInstallError extends Error {
  constructor(
    componentId: string,
    readonly retryable: boolean,
    failures: readonly string[],
  ) {
    super(
      `Runtime component "${componentId}" download failed from all sources: ${failures.join('; ')}`,
    )
    this.name = 'RuntimeComponentInstallError'
  }
}

export function isTransientRuntimeComponentError(error: unknown): boolean {
  if (
    error instanceof RuntimeComponentRequestError ||
    error instanceof RuntimeComponentInstallError
  ) {
    return error.retryable
  }

  const status =
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status?: unknown }).status === 'number'
      ? (error as { status: number }).status
      : undefined
  if (status !== undefined) return TRANSIENT_HTTP_STATUSES.has(status)

  const code =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code.toUpperCase()
      : undefined
  if (code && TRANSIENT_ERROR_CODES.has(code)) return true

  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase()
  return [
    'fetch failed',
    'network',
    'socket hang up',
    'connection reset',
    'connection lost',
    'temporarily unavailable',
    'service unavailable',
    'too many requests',
    'timed out',
    'timeout',
  ].some((fragment) => message.includes(fragment))
}
