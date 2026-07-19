export type ModuleStartupReloadGuardStorage = Pick<
  Storage,
  'getItem' | 'removeItem' | 'setItem'
>

const MODULE_STARTUP_RELOAD_GUARD_KEY = 'yolo:module-startup-reload-attempted'

export function consumeModuleStartupReloadAttempt(
  storage: ModuleStartupReloadGuardStorage,
): boolean {
  try {
    if (storage.getItem(MODULE_STARTUP_RELOAD_GUARD_KEY) === '1') return false
    storage.setItem(MODULE_STARTUP_RELOAD_GUARD_KEY, '1')
    return true
  } catch {
    // Without a durable session guard, suppress reload rather than risk a loop.
    return false
  }
}

export function clearModuleStartupReloadAttempt(
  storage: ModuleStartupReloadGuardStorage,
): void {
  try {
    storage.removeItem(MODULE_STARTUP_RELOAD_GUARD_KEY)
  } catch {
    // A stale guard only suppresses automation; manual recovery remains available.
  }
}
