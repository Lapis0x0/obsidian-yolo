/**
 * Serializes `init` / `embed` / `dispose` handling inside the worker so a
 * caller that (incorrectly, or through a bug elsewhere) fires multiple
 * `embed` messages without awaiting the previous one can't run two ORT
 * inference calls concurrently against the same session — onnxruntime-web
 * doesn't support that, and the concurrent-call safety has to live in the
 * component itself rather than rely on every caller queuing client-side.
 *
 * Plain `Promise` tail-chaining (`queue = queue.then(task)`), factored out
 * here so it can be unit-tested without touching Transformers.js/ORT.
 */
export function createRequestQueue(): {
  /**
   * Runs `task` after every previously enqueued task has settled — success
   * or failure never breaks the chain for subsequent tasks.
   */
  enqueue<T>(task: () => Promise<T>): Promise<T>
} {
  let tail: Promise<unknown> = Promise.resolve()

  return {
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      const result = tail.then(task, task)
      // Swallow rejections in the tail chain itself so one failed task
      // doesn't prevent the next one from running; callers still observe
      // their own task's rejection via the returned promise.
      tail = result.catch(() => undefined)
      return result
    },
  }
}
