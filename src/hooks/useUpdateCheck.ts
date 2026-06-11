import { useEffect, useState } from 'react'

import { usePlugin } from '../contexts/plugin-context'
import type { UpdateCheckResult } from '../core/update/updateChecker'

export function useUpdateCheck(): {
  result: UpdateCheckResult | null
  dismissVersion: (version: string) => void
} {
  const plugin = usePlugin()
  const [result, setResult] = useState<UpdateCheckResult | null>(
    () => plugin.updateCheckResult,
  )

  useEffect(() => {
    const remove = plugin.addUpdateCheckListener(() => {
      setResult(plugin.updateCheckResult)
    })
    return remove
  }, [plugin])

  return {
    result,
    dismissVersion: (version: string) => {
      void plugin.dismissUpdateVersion(version)
    },
  }
}
