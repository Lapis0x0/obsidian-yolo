import { getCliPathOverride } from '../cli-path-override'
import { loadLoginShellEnvironment } from '../login-shell-env'
import type { CliRuntimeFactory, CliRuntimeFactoryDeps } from '../types'

import { grokAgentProfile } from './profile'
import { resolveGrokCommand } from './resolve-command'

export type GrokRuntimeFactoryDeps = CliRuntimeFactoryDeps

const HOST_KEY = 'default'
const NOT_FOUND_MESSAGE =
  'Grok CLI was not found on this device. Install Grok Build (https://docs.x.ai/build), or set a custom CLI path in Settings → Agent, then retry.'

/** Build a subscription-backed Grok runtime over the official CLI's ACP server. */
export const createGrokRuntimeFactory = async (
  deps: GrokRuntimeFactoryDeps,
): Promise<CliRuntimeFactory> => {
  const { AcpCliRuntime } = await import('../acp/AcpCliRuntime')
  const { AcpHostPool } = await import('../acp/host')

  const resolveProcessOptions = async () => {
    const env = (await loadLoginShellEnvironment()) as NodeJS.ProcessEnv
    const cliPathOverride = getCliPathOverride(deps.app, 'grok')
    const resolved = await resolveGrokCommand(
      env,
      process.platform,
      cliPathOverride,
    )
    if (!resolved) throw new Error(NOT_FOUND_MESSAGE)
    return {
      command: resolved.command,
      args: resolved.args,
      cwd: deps.vaultPath,
      // This runtime is subscription-only. Explicitly shadow ambient API-key
      // variables so the child process cannot switch to separately billed API
      // authentication behind the user's cached-token selection.
      env: { XAI_API_KEY: '', GROK_API_KEY: '' },
    }
  }

  const hostPool = new AcpHostPool(() => ({
    runtimeId: 'grok',
    clientName: 'obsidian-yolo',
    resolveProcessOptions,
    selectAuthMethod: grokAgentProfile.selectAuthMethod,
  }))

  return {
    create: (createDeps) => {
      let hostPromise: ReturnType<typeof hostPool.acquire> | null = null
      let acquired = false
      return new AcpCliRuntime('grok', {
        cwd: createDeps.vaultPath,
        resolveHost: () => {
          if (!hostPromise) {
            acquired = true
            hostPromise = hostPool.acquire(HOST_KEY)
          }
          return hostPromise
        },
        releaseHost: () => {
          if (!acquired) return
          acquired = false
          hostPromise = null
          hostPool.release(HOST_KEY)
        },
      })
    },
    dispose: () => hostPool.dispose(),
  }
}
