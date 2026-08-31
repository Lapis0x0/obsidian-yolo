import type { CliRuntimeFactory, CliRuntimeFactoryDeps } from '../types'

export type PiRuntimeFactoryDeps = CliRuntimeFactoryDeps

/**
 * Builds the pi runtime factory. Unlike Claude/Codex/Hermes there is no
 * shared pooled host to warm or dispose here — pi binds a session to its
 * process at launch, so pooling across conversations isn't possible, and
 * each `PiCliRuntime` instance owns its own process(es) directly (see
 * `PiCliRuntime`'s class doc).
 */
export const createPiRuntimeFactory = async (
  _deps: PiRuntimeFactoryDeps,
): Promise<CliRuntimeFactory> => {
  const { PiCliRuntime } = await import('./PiCliRuntime')
  return {
    create: (createDeps) =>
      new PiCliRuntime({
        app: createDeps.app,
        vaultPath: createDeps.vaultPath,
      }),
  }
}
