import { getCliPathOverride } from '../cli-path-override'
import { loadLoginShellEnvironment } from '../login-shell-env'
import type { CliRuntimeFactory, CliRuntimeFactoryDeps } from '../types'

import { hermesAgentProfile } from './profile'
import { HERMES_DEFAULT_PROFILE_ID } from './profiles'
import { resolveHermesCommand } from './resolve-command'

export type HermesRuntimeFactoryDeps = CliRuntimeFactoryDeps

const NOT_FOUND_MESSAGE =
  'Hermes CLI was not found on this device. Install Hermes (https://github.com/NousResearch/hermes-agent), or set a custom CLI path in Settings → Agent, then retry.'

/**
 * Builds the Hermes runtime factory. One `AcpHostPool` is shared by every
 * Hermes `CliRuntime` this factory creates, keyed by profile id — a
 * profile can only be selected when its process is launched (`hermes -p
 * <profile> acp`), so two conversations under different profiles must get
 * two separate subprocesses, not the single shared host this pool used to
 * hand out unconditionally. Each key's host is created lazily on first
 * acquire and disposed once nothing still references it (see
 * `AcpHostPool`'s reference counting) — Hermes is a non-trivial Python
 * process, so idle profiles are reclaimed rather than kept forever.
 *
 * Command resolution re-runs on every host respawn, so an install or path
 * override picked up after startup takes effect on the next attempt without
 * restarting Obsidian.
 */
export const createHermesRuntimeFactory = async (
  deps: HermesRuntimeFactoryDeps,
): Promise<CliRuntimeFactory> => {
  const { AcpCliRuntime } = await import('../acp/AcpCliRuntime')
  const { AcpHostPool } = await import('../acp/host')

  const resolveProcessOptionsForProfile = (profileId: string) => async () => {
    const env = (await loadLoginShellEnvironment()) as NodeJS.ProcessEnv
    const cliPathOverride = getCliPathOverride(deps.app, 'hermes')
    const resolved = await resolveHermesCommand(
      env,
      process.platform,
      cliPathOverride,
      profileId,
    )
    if (!resolved) throw new Error(NOT_FOUND_MESSAGE)
    return {
      command: resolved.command,
      args: resolved.args,
      cwd: deps.vaultPath,
    }
  }

  const hostPool = new AcpHostPool((profileId) => ({
    runtimeId: 'hermes',
    clientName: 'obsidian-yolo',
    resolveProcessOptions: resolveProcessOptionsForProfile(profileId),
  }))

  return {
    create: (createDeps) => {
      const profileId = createDeps.profileId ?? HERMES_DEFAULT_PROFILE_ID
      // Tracks how many times *this* runtime instance acquired each pool key
      // (its own profile, and — only if `sessionRecovery` ever fires — the
      // default profile too), so `releaseHost` gives back exactly as many
      // references as were acquired. A plain `Set` of keys undercounts when
      // the primary profile *is* already `default`: `resolveHost()` and
      // `sessionRecovery.resolveHost()` then acquire the same key twice
      // (`AcpHostPool.acquire` bumps `refCount` on every call), and a Set
      // would only remember to release it once, leaking a reference and
      // keeping the Hermes subprocess alive forever.
      const acquiredKeyCounts = new Map<string, number>()
      const acquire = async (key: string) => {
        const host = await hostPool.acquire(key)
        acquiredKeyCounts.set(key, (acquiredKeyCounts.get(key) ?? 0) + 1)
        return host
      }
      return new AcpCliRuntime('hermes', {
        cwd: createDeps.vaultPath,
        resolveHost: () => acquire(profileId),
        // Resuming a session whose profile no longer loads (deleted,
        // corrupted sessions.db, ...) falls back to a fresh session under
        // the default profile rather than failing the conversation outright.
        sessionRecovery: {
          resolveHost: () => acquire(HERMES_DEFAULT_PROFILE_ID),
        },
        releaseHost: () => {
          for (const [key, count] of acquiredKeyCounts) {
            for (let index = 0; index < count; index += 1) {
              hostPool.release(key)
            }
          }
          acquiredKeyCounts.clear()
        },
        compactCommand: hermesAgentProfile.compactCommand,
      })
    },
    warm: () => hostPool.warm(HERMES_DEFAULT_PROFILE_ID),
    dispose: () => hostPool.dispose(),
  }
}
