import { getCliPathOverride } from '../cli-path-override'
import type { CliRuntimeFactory, CliRuntimeFactoryDeps } from '../types'

import type { ClaudeCliRuntimeOptions } from './ClaudeCliRuntime'

export type ClaudeRuntimeOptions = Omit<ClaudeCliRuntimeOptions, 'vaultPath'>

export type ClaudeRuntimeFactoryDeps = CliRuntimeFactoryDeps &
  Readonly<{
    getClaudeRuntimeOptions?: () => ClaudeRuntimeOptions
  }>

/**
 * Builds the Claude Code runtime factory. Falls back to auto-detecting the
 * CLI binary (device-local path override, then PATH probing inside
 * `ClaudeCliRuntime`) when the caller does not supply its own options.
 */
export const createClaudeRuntimeFactory = async (
  deps: ClaudeRuntimeFactoryDeps,
): Promise<CliRuntimeFactory> => {
  const { ClaudeCliRuntime } = await import('./ClaudeCliRuntime')

  const getClaudeRuntimeOptions =
    deps.getClaudeRuntimeOptions ??
    ((): ClaudeRuntimeOptions => ({
      getConfiguredCliPath: () => getCliPathOverride(deps.app, 'claude-code'),
    }))

  return {
    create: (createDeps) =>
      new ClaudeCliRuntime({
        ...getClaudeRuntimeOptions(),
        vaultPath: createDeps.vaultPath,
      }),
  }
}
