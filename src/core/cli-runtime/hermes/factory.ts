import { getCliPathOverride } from '../cli-path-override'
import { loadLoginShellEnvironment } from '../login-shell-env'
import type { CliRuntimeFactory, CliRuntimeFactoryDeps } from '../types'

import { hermesAgentProfile } from './profile'

export type HermesRuntimeFactoryDeps = CliRuntimeFactoryDeps

const NOT_FOUND_MESSAGE =
  'Hermes CLI was not found on this device. Install Hermes (https://github.com/NousResearch/hermes-agent), or set a custom CLI path in Settings → Agent, then retry.'

/**
 * Builds the Hermes runtime factory: one shared ACP host (subprocess +
 * connection) backs every Hermes `CliRuntime` this factory creates, mirroring
 * Codex's pooled app-server host. Command resolution re-runs on every host
 * respawn, so an install or path override picked up after startup takes
 * effect on the next attempt without restarting Obsidian.
 */
export const createHermesRuntimeFactory = async (
  deps: HermesRuntimeFactoryDeps,
): Promise<CliRuntimeFactory> => {
  const { AcpCliRuntime } = await import('../acp/AcpCliRuntime')
  const { AcpHostPool } = await import('../acp/host')

  const resolveProcessOptions = async () => {
    const env = (await loadLoginShellEnvironment()) as NodeJS.ProcessEnv
    const cliPathOverride = getCliPathOverride(deps.app, 'hermes')
    const resolved = await hermesAgentProfile.resolveCommand(
      env,
      cliPathOverride,
    )
    if (!resolved) throw new Error(NOT_FOUND_MESSAGE)
    return {
      command: resolved.command,
      args: resolved.args,
      cwd: deps.vaultPath,
    }
  }

  const hostPool = new AcpHostPool({
    runtimeId: 'hermes',
    clientName: 'obsidian-yolo',
    resolveProcessOptions,
  })

  return {
    create: (createDeps) =>
      new AcpCliRuntime('hermes', {
        cwd: createDeps.vaultPath,
        resolveHost: hostPool.acquire,
      }),
    warm: () => hostPool.warm(),
    dispose: () => hostPool.dispose(),
  }
}
