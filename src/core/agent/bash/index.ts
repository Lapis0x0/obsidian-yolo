import { Platform } from 'obsidian'

import type { RunBashParams, RunBashResult } from './session-manager'

export type { RunBashParams, RunBashResult } from './session-manager'

export async function runBash(params: RunBashParams): Promise<RunBashResult> {
  if (!Platform.isDesktop) {
    throw new Error('Terminal command tool is only available on desktop.')
  }
  const { runBash: run } = await import('./session-manager')
  return run(params)
}

export async function killAllBashSessions(): Promise<void> {
  if (!Platform.isDesktop) return
  const { killAllBashSessions: killAll } = await import('./session-manager')
  killAll()
}
