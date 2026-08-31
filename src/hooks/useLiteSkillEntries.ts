import { App } from 'obsidian'
import { useEffect, useState } from 'react'

import {
  type LiteSkillEntry,
  type LiteSkillScope,
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
    /** Scopes the result to a module chat mode's own skills in addition to
     * the always-included user/global bucket. Omitted (the default) for
     * every non-module call site. */
    scope?: LiteSkillScope
  },
): LiteSkillEntry[] {
  const [entries, setEntries] = useState<LiteSkillEntry[]>([])
  const settings = options?.settings
  const refreshTick = options?.refreshTick ?? 0
  const moduleChatModeId = options?.scope?.moduleChatModeId

  useEffect(() => {
    let cancelled = false
    void listLiteSkillEntries(app, {
      settings,
      scope: moduleChatModeId ? { moduleChatModeId } : undefined,
    }).then((list) => {
      if (!cancelled) {
        setEntries(list)
      }
    })
    return () => {
      cancelled = true
    }
  }, [app, settings, refreshTick, moduleChatModeId])

  return entries
}
