import type { App } from 'obsidian'

import type { ReleaseNotesByLanguage } from './updateChecker'

/** One update automatic updating installed, as the card reports it. */
export type AutoUpdatedItem = Readonly<{
  key: string
  name: string
  version: string
  releaseNotes: ReleaseNotesByLanguage | null
}>

export type AutoUpdatedCore = Readonly<{
  version: string
  releaseNotes: ReleaseNotesByLanguage
}>

/**
 * The core version automatic updating just installed, handed from the plugin
 * instance that installs it to the one it reloads into, which reports it.
 *
 * Device-local for the same reason as the last launched core version: a
 * synchronized value would reach a second device that updated nothing.
 */
const AUTO_UPDATED_CORE_KEY = 'yolo-auto-updated-core'

type AutoUpdatedCoreStorage = Pick<App, 'loadLocalStorage' | 'saveLocalStorage'>

export function writeAutoUpdatedCore(
  app: AutoUpdatedCoreStorage,
  core: AutoUpdatedCore,
): void {
  app.saveLocalStorage(AUTO_UPDATED_CORE_KEY, core)
}

/**
 * Reads and clears the handoff. It only counts when this instance runs the
 * version it names: a handoff whose reload never happened says nothing about
 * the core running now.
 */
export function takeAutoUpdatedCore(
  app: AutoUpdatedCoreStorage,
  runningVersion: string,
): AutoUpdatedCore | null {
  const stored: unknown = app.loadLocalStorage(AUTO_UPDATED_CORE_KEY)
  if (stored === null || stored === undefined) return null
  app.saveLocalStorage(AUTO_UPDATED_CORE_KEY, null)
  if (typeof stored !== 'object') return null
  const { version, releaseNotes } = stored as Partial<AutoUpdatedCore>
  if (version !== runningVersion || typeof releaseNotes !== 'object') {
    return null
  }
  return { version, releaseNotes }
}
