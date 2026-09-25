import type { App } from 'obsidian'

/**
 * The core version this vault last started on, on this device.
 *
 * Device-local on purpose: a synchronized value would arrive on a second
 * device together with the new plugin files, so that device would start on
 * the new core believing it had already run it, and its modules would never
 * follow the core update.
 */
const LAST_LAUNCHED_CORE_VERSION_KEY = 'yolo-last-launched-core-version'

export type LastLaunchedCoreVersionStorage = Pick<
  App,
  'loadLocalStorage' | 'saveLocalStorage'
>

export function readLastLaunchedCoreVersion(
  app: LastLaunchedCoreVersionStorage,
): string | null {
  const stored: unknown = app.loadLocalStorage(LAST_LAUNCHED_CORE_VERSION_KEY)
  return typeof stored === 'string' ? stored : null
}

export function writeLastLaunchedCoreVersion(
  app: LastLaunchedCoreVersionStorage,
  version: string,
): void {
  app.saveLocalStorage(LAST_LAUNCHED_CORE_VERSION_KEY, version)
}
