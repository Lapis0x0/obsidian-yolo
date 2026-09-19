import { useCallback, useEffect, useMemo, useState } from 'react'

/**
 * Holds a just-dropped order until the saved one comes back.
 *
 * Persisting settings is async. Rendering straight from the saved list means
 * that between the drop and the save landing, the item sits back where the
 * drag began and then jumps forward — a visible flinch. This keeps the dropped
 * order locally for that gap, and lets go of it as soon as `items` changes.
 */
export function useOptimisticOrder<T>(
  items: readonly T[],
  getId: (item: T) => string,
) {
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null)

  useEffect(() => {
    setPendingOrder(null)
  }, [items])

  const ordered = useMemo(() => {
    if (!pendingOrder) return items
    const byId = new Map(items.map((item) => [getId(item), item]))
    // An id that no longer resolves was removed while the save was in flight.
    return pendingOrder.flatMap((id) => {
      const item = byId.get(id)
      return item === undefined ? [] : [item]
    })
  }, [items, pendingOrder, getId])

  const applyOrder = useCallback(
    (next: readonly T[]) => setPendingOrder(next.map(getId)),
    [getId],
  )

  /** Drop the local order after a failed save, falling back to what is saved. */
  const revertOrder = useCallback(() => setPendingOrder(null), [])

  return { ordered, applyOrder, revertOrder }
}
