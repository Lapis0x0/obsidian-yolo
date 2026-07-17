import { useEffect, useState } from 'react'

import { usePlugin } from '../contexts/plugin-context'
import type { PluginUpdateState } from '../core/update/pluginUpdater'

export function usePluginUpdate(): {
  state: PluginUpdateState
  canSelfUpdate: boolean
  startDownload: () => void
  applyUpdate: () => void
} {
  const plugin = usePlugin()
  const [state, setState] = useState<PluginUpdateState>(
    () => plugin.pluginUpdateState,
  )

  useEffect(() => {
    const remove = plugin.addPluginUpdateListener(() => {
      setState(plugin.pluginUpdateState)
    })
    return remove
  }, [plugin])

  return {
    state,
    canSelfUpdate: plugin.canSelfUpdatePlugin(),
    startDownload: () => {
      void plugin.startPluginUpdateDownload()
    },
    applyUpdate: () => {
      void plugin.applyPluginUpdate()
    },
  }
}
