/**
 * `createRequestQueue` lives under `runtime-components/` (see
 * `bashEngineReadOnly.test.ts` for why it's outside Jest's `roots`) and is
 * imported directly by relative path.
 *
 * Verifies the serialization contract `worker.ts` relies on to close the
 * "concurrent embed() calls into the same ORT session" gap the review
 * flagged: two overlapping `embed` messages must run strictly one after the
 * other, and one task failing must not stall or corrupt the tasks queued
 * behind it.
 */
import { createRequestQueue } from '../../../runtime-components/embedding-engine/src/requestQueue'

describe('createRequestQueue', () => {
  it('runs enqueued tasks strictly one at a time, in order', async () => {
    const queue = createRequestQueue()
    const order: string[] = []
    const deferred = <T>(): {
      promise: Promise<T>
      resolve: (value: T) => void
    } => {
      let resolve!: (value: T) => void
      const promise = new Promise<T>((r) => {
        resolve = r
      })
      return { promise, resolve }
    }

    const first = deferred<undefined>()

    const p1 = queue.enqueue(async () => {
      order.push('start-1')
      await first.promise
      order.push('end-1')
    })
    const p2 = queue.enqueue(async () => {
      // If the queue failed to serialize, task 2 would already be running
      // here (task 1 hasn't resolved `first` yet).
      order.push('start-2')
      order.push('end-2')
    })

    // Give the microtask queue a tick — task 1 should have started, task 2
    // should not have (it's still behind task 1 in the tail chain).
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(['start-1'])

    first.resolve(undefined)
    await p1
    await p2

    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2'])
  })

  it('runs the next task even if the previous one rejected', async () => {
    const queue = createRequestQueue()
    const failing = queue.enqueue(() => Promise.reject(new Error('boom')))
    const succeeding = queue.enqueue(() => Promise.resolve('ok'))

    await expect(failing).rejects.toThrow('boom')
    await expect(succeeding).resolves.toBe('ok')
  })

  it('lets each caller observe only their own task result', async () => {
    const queue = createRequestQueue()
    const results = await Promise.all([
      queue.enqueue(() => Promise.resolve(1)),
      queue.enqueue(() => Promise.resolve(2)),
      queue.enqueue(() => Promise.resolve(3)),
    ])
    expect(results).toEqual([1, 2, 3])
  })
})
