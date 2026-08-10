import { type App, Platform } from 'obsidian'

import type { CliRuntimeId } from './types'

/**
 * Absolute CLI paths are machine-specific, so overrides live in Obsidian's
 * device-local storage instead of the synced plugin settings. Empty or blank
 * values mean "auto-detect".
 */
const storageKey = (runtimeId: CliRuntimeId): string =>
  `yolo-cli-path:${runtimeId}`

export const getCliPathOverride = (
  app: App,
  runtimeId: CliRuntimeId,
): string | undefined => {
  const value: unknown = app.loadLocalStorage(storageKey(runtimeId))
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

export const setCliPathOverride = (
  app: App,
  runtimeId: CliRuntimeId,
  value: string,
): void => {
  const trimmed = value.trim()
  app.saveLocalStorage(storageKey(runtimeId), trimmed || null)
}

/**
 * Settings-UI validation only; resolution itself falls through to
 * auto-detection when the override does not point at an existing file.
 * Empty values are valid (they mean "auto-detect").
 */
export const cliPathOverrideExists = async (
  value: string,
): Promise<boolean> => {
  const trimmed = value.trim()
  if (!trimmed || !Platform.isDesktop) return true
  try {
    // eslint-disable-next-line import/no-nodejs-modules -- evaluated only behind the Platform.isDesktop gate above
    const { stat } = await import('node:fs/promises')
    // eslint-disable-next-line import/no-nodejs-modules -- evaluated only behind the Platform.isDesktop gate above
    const { homedir } = await import('node:os')
    const expanded =
      trimmed === '~'
        ? homedir()
        : trimmed.startsWith('~/')
          ? `${homedir()}/${trimmed.slice(2)}`
          : trimmed
    return (await stat(expanded)).isFile()
  } catch {
    return false
  }
}
