import { useSyncExternalStore } from 'react'

import { usePlugin } from '../contexts/plugin-context'
import type { ModuleUpdateOffer } from '../core/update/moduleUpdateController'

const EMPTY: readonly ModuleUpdateOffer[] = Object.freeze([])

export function useModuleUpdates(): readonly ModuleUpdateOffer[] {
  const plugin = usePlugin()
  return useSyncExternalStore(
    plugin.subscribeModuleUpdates,
    plugin.getModuleUpdateSnapshot,
    () => EMPTY,
  )
}
