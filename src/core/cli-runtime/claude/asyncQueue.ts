export class AsyncPushQueue<T> implements AsyncIterableIterator<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T, void>) => void> =
    []
  private closed = false

  push(value: T): void {
    if (this.closed) {
      throw new Error('Cannot push to a closed Claude input stream.')
    }

    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ done: false, value })
      return
    }
    this.values.push(value)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined })
    }
  }

  next(): Promise<IteratorResult<T, void>> {
    const value = this.values.shift()
    if (value !== undefined) {
      return Promise.resolve({ done: false, value })
    }
    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined })
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve)
    })
  }

  return(): Promise<IteratorResult<T, void>> {
    this.close()
    return Promise.resolve({ done: true, value: undefined })
  }

  throw(error?: unknown): Promise<IteratorResult<T, void>> {
    this.close()
    return Promise.reject(
      error instanceof Error ? error : new Error(String(error)),
    )
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this
  }
}
