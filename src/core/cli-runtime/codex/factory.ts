import { getCliPathOverride } from '../cli-path-override'
import { loadLoginShellEnvironment } from '../login-shell-env'
import type { CliRuntimeFactory, CliRuntimeFactoryDeps } from '../types'

import { CodexAppServerHostPool } from './host'
import { type ResolvedCodexLaunch, resolveCodexLaunch } from './launch'
import type { CodexProcessOptions } from './process'
import type { CodexCliRuntimeOptions } from './runtime'

export type CodexRuntimeOptions = Omit<
  CodexCliRuntimeOptions,
  'cwd' | 'resolveHost'
> & {
  cwd?: string
}

export type CodexRuntimeFactoryDeps = CliRuntimeFactoryDeps &
  Readonly<{
    getCodexRuntimeOptions?: () => CodexRuntimeOptions
  }>

/**
 * Builds the Codex runtime factory, including the shared app-server host
 * pool: one pooled host process backs every Codex `CliRuntime` this factory
 * creates, so it is constructed once here and torn down via `dispose()`
 * rather than owned by the coordinator.
 *
 * Falls back to resolving the launch command from the login-shell PATH
 * (auto-detect) when the caller does not supply its own options; the
 * fallback re-resolves on every host respawn so an install or path override
 * picked up after startup takes effect on the next attempt.
 */
export const createCodexRuntimeFactory = async (
  deps: CodexRuntimeFactoryDeps,
): Promise<CliRuntimeFactory> => {
  const { CodexCliRuntime } = await import('./runtime')

  let getCodexRuntimeOptions = deps.getCodexRuntimeOptions
  let resolveProcessOptions: (() => Promise<CodexProcessOptions>) | undefined

  if (!getCodexRuntimeOptions) {
    const resolveLaunch = async (): Promise<ResolvedCodexLaunch> =>
      resolveCodexLaunch(
        deps.vaultPath,
        (await loadLoginShellEnvironment()) as NodeJS.ProcessEnv,
        process.platform,
        getCliPathOverride(deps.app, 'codex'),
      )
    let launchSnapshot = await resolveLaunch()
    getCodexRuntimeOptions = (): CodexRuntimeOptions => ({
      command: launchSnapshot.command,
      cwd: launchSnapshot.runtimeCwd,
      spawnCwd: launchSnapshot.spawnCwd,
      launchArgs: launchSnapshot.launchArgs,
      mapRuntimePathToHost: launchSnapshot.mapRuntimePathToHost,
    })
    resolveProcessOptions = async (): Promise<CodexProcessOptions> => {
      launchSnapshot = await resolveLaunch()
      return {
        command: launchSnapshot.command,
        cwd: launchSnapshot.runtimeCwd,
        spawnCwd: launchSnapshot.spawnCwd,
        launchArgs: launchSnapshot.launchArgs,
      }
    }
  }

  const initialOptions = getCodexRuntimeOptions()
  const hostPool = new CodexAppServerHostPool({
    ...initialOptions,
    cwd: initialOptions.cwd ?? deps.vaultPath,
    resolveProcessOptions,
  })

  return {
    create: (createDeps) => {
      const options = getCodexRuntimeOptions()
      return new CodexCliRuntime({
        ...options,
        cwd: options.cwd ?? createDeps.vaultPath,
        resolveHost: hostPool.acquire,
      })
    },
    warm: () => hostPool.warm(),
    dispose: () => hostPool.dispose(),
  }
}
