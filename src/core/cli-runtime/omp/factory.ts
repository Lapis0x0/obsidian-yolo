import type { CliRuntimeFactory, CliRuntimeFactoryDeps } from '../types'

export type OmpRuntimeFactoryDeps = CliRuntimeFactoryDeps

/**
 * Builds the omp runtime factory. omp runs on pi's protocol engine with its
 * own dialect, so this mirrors `createPiRuntimeFactory` exactly — including
 * having no shared pooled host to warm or dispose (see `PiCliRuntime`'s class
 * doc for why that model does not apply here).
 */
export const createOmpRuntimeFactory = async (
  _deps: OmpRuntimeFactoryDeps,
): Promise<CliRuntimeFactory> => {
  const [{ PiCliRuntime }, { OMP_RUNTIME_DIALECT }] = await Promise.all([
    import('../pi/PiCliRuntime'),
    import('./dialect'),
  ])
  return {
    create: (createDeps) =>
      new PiCliRuntime({
        app: createDeps.app,
        vaultPath: createDeps.vaultPath,
        dialect: OMP_RUNTIME_DIALECT,
      }),
  }
}
