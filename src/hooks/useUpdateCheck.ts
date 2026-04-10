import { useEffect, useState } from 'react'

import type { UpdateCheckResult } from '../core/update/updateChecker'
import { usePlugin } from '../contexts/plugin-context'

export function useUpdateCheck(): {
  result: UpdateCheckResult | null
  dismissed: boolean
  dismiss: () => void
} {
  const plugin = usePlugin()
  const [result, setResult] = useState<UpdateCheckResult | null>(
    () => plugin.updateCheckResult,
  )
  const [dismissed, setDismissed] = useState(() =>
    plugin.isUpdateBannerDismissed(),
  )

  useEffect(() => {
    const remove = plugin.addUpdateCheckListener(() => {
      setResult(plugin.updateCheckResult)
      setDismissed(plugin.isUpdateBannerDismissed())
    })
    return remove
  }, [plugin])

  return {
    result,
    dismissed,
    dismiss: () => {
      plugin.dismissUpdateBanner()
    },
  }
}
