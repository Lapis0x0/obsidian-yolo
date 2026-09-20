import { getCliPathOverride } from '../cli-path-override'
import { loadLoginShellEnvironment } from '../login-shell-env'
import type { CliRuntimeFactory, CliRuntimeFactoryDeps } from '../types'

import { codebuddyAgentProfile } from './profile'
import { resolveCodebuddyCommand } from './resolve-command'

export type CodebuddyRuntimeFactoryDeps = CliRuntimeFactoryDeps

const HOST_KEY = 'default'
const NOT_FOUND_MESSAGE =
  'CodeBuddy Code was not found on this device. Install it with "npm install -g @tencent-ai/codebuddy-code", or set a custom CLI path in Settings → Agent, then retry.'

/**
 * Builds the CodeBuddy Code runtime over the CLI's own ACP server.
 *
 * Every conversation shares one pooled subprocess: CodeBuddy has no profile
 * concept to key hosts by (unlike Hermes), and ACP already multiplexes
 * sessions over a single connection. The pool's reference counting still
 * earns its place — CodeBuddy is a large Node process, so it is reclaimed
 * once no conversation still binds it rather than kept alive for the
 * lifetime of the plugin.
 *
 * Command resolution re-runs on every host respawn, so installing CodeBuddy
 * or setting a path override after startup takes effect on the next attempt
 * without restarting Obsidian.
 */
export const createCodebuddyRuntimeFactory = async (
  deps: CodebuddyRuntimeFactoryDeps,
): Promise<CliRuntimeFactory> => {
  const { AcpCliRuntime } = await import('../acp/AcpCliRuntime')
  const { AcpHostPool } = await import('../acp/host')

  const resolveProcessOptions = async () => {
    const env = (await loadLoginShellEnvironment()) as NodeJS.ProcessEnv
    const cliPathOverride = getCliPathOverride(deps.app, 'codebuddy')
    const resolved = await resolveCodebuddyCommand(
      env,
      process.platform,
      cliPathOverride,
    )
    if (!resolved) throw new Error(NOT_FOUND_MESSAGE)
    return {
      command: resolved.command,
      args: resolved.args,
      cwd: deps.vaultPath,
    }
  }

  const hostPool = new AcpHostPool(() => ({
    runtimeId: 'codebuddy',
    clientName: 'obsidian-yolo',
    resolveProcessOptions,
  }))

  return {
    create: (createDeps) => {
      let hostPromise: ReturnType<typeof hostPool.acquire> | null = null
      let acquired = false
      return new AcpCliRuntime('codebuddy', {
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
        profile: codebuddyAgentProfile,
      })
    },
    dispose: () => hostPool.dispose(),
  }
}
