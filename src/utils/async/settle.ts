/**
 * Races a promise against a deadline, or against an AbortSignal, or both.
 *
 * Both helpers always attach handlers to `operation` before deciding the
 * outcome. A promise abandoned by the race is expected; an unhandled
 * rejection from it is not, so it is observed either way. Callers supply the
 * message because the domain names the failure ("update download request
 * timed out", "module readiness reconciler is disposed"), not this file.
 */
export function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
  signal?: AbortSignal,
  abortMessage = 'Operation was aborted',
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      globalThis.clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      settle()
    }
    const onAbort = (): void => {
      finish(() => reject(new Error(abortMessage)))
    }
    const timer = globalThis.setTimeout(() => {
      finish(() => reject(new Error(timeoutMessage)))
    }, timeoutMs)

    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) =>
        finish(() =>
          reject(error instanceof Error ? error : new Error(String(error))),
        ),
    )
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function withAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  abortMessage: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      settle()
    }
    const onAbort = (): void => {
      finish(() => reject(new Error(abortMessage)))
    }

    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) =>
        finish(() =>
          reject(error instanceof Error ? error : new Error(String(error))),
        ),
    )
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
