/**
 * FIFO serialization of async work per key, scoped to an owner object.
 *
 * Module installs, device-state transactions, and namespaced settings writes
 * all need the same rule: at most one operation in flight for a given path,
 * a failed operation must not block the next one, and a key must not leak
 * once its queue drains. The owner is held weakly (it is an Obsidian adapter
 * in every current caller), so queues disappear with the object they guard.
 */
const queuesByOwner = new WeakMap<object, Map<string, Promise<void>>>()

export function runSerialByKey<T>(
  owner: object,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  let queues = queuesByOwner.get(owner)
  if (!queues) {
    queues = new Map()
    queuesByOwner.set(owner, queues)
  }
  const previous = queues.get(key) ?? Promise.resolve()
  const result = previous.catch(() => undefined).then(operation)
  const tail = result.then(
    () => undefined,
    () => undefined,
  )
  queues.set(key, tail)
  void tail.then(() => {
    if (queues?.get(key) === tail) queues.delete(key)
  })
  return result
}
