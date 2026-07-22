export const MANAGED_WRITE_DRAIN_TIMEOUT_MS = 30_000

export class PendingWriteTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Managed voice writes did not settle within ${timeoutMs} ms.`)
    this.name = 'PendingWriteTimeoutError'
  }
}

/** Tracks Vault writes that must settle before the managed root can move. */
export class PendingWriteTracker {
  private readonly pending = new Set<Promise<unknown>>()

  track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation)
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    )
    return operation
  }

  async waitForSettled(
    timeoutMs = MANAGED_WRITE_DRAIN_TIMEOUT_MS,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs

    // A completed write can enqueue another write, so resnapshot until the
    // tracker is empty while retaining one deadline for the whole drain.
    while (this.pending.size > 0) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) throw new PendingWriteTimeoutError(timeoutMs)
      await waitForOperations(Array.from(this.pending), remainingMs, timeoutMs)
    }
  }
}

async function waitForOperations(
  operations: Promise<unknown>[],
  remainingMs: number,
  timeoutMs: number,
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.allSettled(operations),
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(
          () => reject(new PendingWriteTimeoutError(timeoutMs)),
          remainingMs,
        )
      }),
    ])
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}
