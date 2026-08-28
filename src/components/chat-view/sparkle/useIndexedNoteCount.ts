import { useEffect, useRef, useState } from 'react'

import { useDatabase } from '../../../contexts/database-context'
import { useSettings } from '../../../contexts/settings-context'

/**
 * How many distinct notes the searched scope actually holds — the number the
 * panel's scope row shows, so "nothing found" can never be mistaken for
 * "the feature is broken".
 *
 * Knowledge bases are separate databases that may cover overlapping folders,
 * so the count is the union of their indexed paths, not the sum. `null`
 * while it is still being read.
 */
export function useIndexedNoteCount({
  scopeKbId,
  visible,
  refreshToken,
}: {
  scopeKbId?: string
  visible: boolean
  refreshToken: number
}): number | null {
  const { settings } = useSettings()
  const { getVectorManager } = useDatabase()
  const [count, setCount] = useState<number | null>(null)
  const generationRef = useRef(0)

  const embeddingModelId = settings.embeddingModelId
  const kbIds = settings.knowledgeBases
    .filter((kb) => !scopeKbId || kb.id === scopeKbId)
    .map((kb) => kb.id)
    .join('\n')

  useEffect(() => {
    if (!visible) return
    const ids = kbIds === '' ? [] : kbIds.split('\n')
    if (ids.length === 0) {
      setCount(0)
      return
    }

    const generation = ++generationRef.current
    void (async () => {
      try {
        const paths = new Set<string>()
        for (const kbId of ids) {
          const vectorManager = await getVectorManager(kbId)
          for (const path of await vectorManager.listIndexedPaths(
            embeddingModelId,
          )) {
            paths.add(path)
          }
        }
        if (generationRef.current !== generation) return
        setCount(paths.size)
      } catch (error) {
        if (generationRef.current !== generation) return
        console.warn('[YOLO] Failed to count indexed notes.', error)
        setCount(null)
      }
    })()
  }, [getVectorManager, embeddingModelId, kbIds, visible, refreshToken])

  return count
}
