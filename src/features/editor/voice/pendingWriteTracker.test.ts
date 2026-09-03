import {
  PendingWriteTimeoutError,
  PendingWriteTracker,
} from './pendingWriteTracker'

describe('PendingWriteTracker', () => {
  it('waits for tracked writes and drains writes queued while waiting', async () => {
    const tracker = new PendingWriteTracker()
    let resolveFirst!: () => void
    let resolveSecond!: () => void
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve
    })
    const second = new Promise<void>((resolve) => {
      resolveSecond = resolve
    })
    tracker.track(first)

    let settled = false
    const wait = tracker.waitForSettled().then(() => {
      settled = true
    })
    tracker.track(second)
    resolveFirst()
    await Promise.resolve()
    expect(settled).toBe(false)

    resolveSecond()
    await wait
    expect(settled).toBe(true)
  })

  it('treats rejected writes as settled', async () => {
    const tracker = new PendingWriteTracker()
    const operation = Promise.reject(new Error('write failed'))
    tracker.track(operation)

    await expect(operation).rejects.toThrow('write failed')
    await expect(tracker.waitForSettled()).resolves.toBeUndefined()
  })

  it('rejects instead of waiting forever', async () => {
    jest.useFakeTimers()
    try {
      const tracker = new PendingWriteTracker()
      tracker.track(new Promise<void>(() => undefined))
      const wait = tracker.waitForSettled(100)
      const expectation = expect(wait).rejects.toBeInstanceOf(
        PendingWriteTimeoutError,
      )

      await jest.advanceTimersByTimeAsync(100)
      await expectation
    } finally {
      jest.useRealTimers()
    }
  })
})
