import { useEffect, useState } from 'react'

import { usePlugin } from '../contexts/plugin-context'

export function useInstallationIncompleteBanner(): {
  detail: {
    bakedVersion: string
    manifestVersion: string
  } | null
  dismissed: boolean
  dismiss: () => void
} {
  const plugin = usePlugin()
  const [detail, setDetail] = useState(
    () => plugin.installationIncompleteDetail,
  )
  const [dismissed, setDismissed] = useState(() =>
    plugin.isInstallationIncompleteBannerDismissed(),
  )

  useEffect(() => {
    const sync = () => {
      setDetail(plugin.installationIncompleteDetail)
      setDismissed(plugin.isInstallationIncompleteBannerDismissed())
    }
    // 与 onload 中 notify 的时序对齐：先同步一次，避免订阅晚于 notify 导致永远不显示
    sync()
    return plugin.addInstallationIncompleteListener(sync)
  }, [plugin])

  return {
    detail,
    dismissed,
    dismiss: () => {
      plugin.dismissInstallationIncompleteBanner()
    },
  }
}
