import { App } from 'obsidian'
import { useEffect, useState } from 'react'

import {
  type LiteSkillEntry,
  listLiteSkillEntries,
} from '../core/skills/liteSkills'

type SkillSettings = {
  yolo?: {
    baseDir?: string
  }
}

export function useLiteSkillEntries(
  app: App,
  options?: {
    settings?: SkillSettings
    /** Bump to force a reload (e.g. after creating a skill file). */
    refreshTick?: number
  },
): LiteSkillEntry[] {
  const [entries, setEntries] = useState<LiteSkillEntry[]>([])
  const settings = options?.settings
  const refreshTick = options?.refreshTick ?? 0

  useEffect(() => {
    let cancelled = false
    void listLiteSkillEntries(app, { settings }).then((list) => {
      if (!cancelled) {
        setEntries(list)
      }
    })
    return () => {
      cancelled = true
    }
  }, [app, settings, refreshTick])

  return entries
}
