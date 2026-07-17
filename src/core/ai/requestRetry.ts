const NON_RETRYABLE_REQUEST_ERROR = Symbol('non-retryable-request-error')

type ClassifiedRequestError = Error & {
  [NON_RETRYABLE_REQUEST_ERROR]: true
}

export const markRequestErrorNonRetryable = (
  error: unknown,
): ClassifiedRequestError => {
  const classified =
    error instanceof Error
      ? error
      : new Error(typeof error === 'string' ? error : JSON.stringify(error))

  if (!isRequestErrorNonRetryable(classified)) {
    Object.defineProperty(classified, NON_RETRYABLE_REQUEST_ERROR, {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    })
  }
  return classified as ClassifiedRequestError
}

export const isRequestErrorNonRetryable = (error: unknown): boolean =>
  error instanceof Error &&
  (error as Partial<ClassifiedRequestError>)[NON_RETRYABLE_REQUEST_ERROR] ===
    true
