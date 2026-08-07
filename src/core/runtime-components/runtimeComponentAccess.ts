import type { RuntimeComponentId, RuntimeComponentLease } from './contracts'
import type { RuntimeComponentService } from './runtimeComponentService'

let service: RuntimeComponentService | null = null
let testAcquirer:
  | (<I extends RuntimeComponentId>(id: I) => Promise<RuntimeComponentLease<I>>)
  | null = null

export function setRuntimeComponentService(
  next: RuntimeComponentService | null,
): void {
  service = next
}

export function acquireRuntimeComponent<I extends RuntimeComponentId>(
  id: I,
): Promise<RuntimeComponentLease<I>> {
  if (testAcquirer) return testAcquirer(id)
  if (!service) {
    throw new Error(`Runtime component "${id}" is unavailable`)
  }
  return service.acquire(id)
}

export function setRuntimeComponentAcquirerForTests(
  acquirer:
    | (<I extends RuntimeComponentId>(
        id: I,
      ) => Promise<RuntimeComponentLease<I>>)
    | null,
): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Runtime component acquirer overrides are test-only')
  }
  testAcquirer = acquirer
}

let testEnabledOverride: ((id: RuntimeComponentId) => boolean) | null = null

/**
 * Whether the user has this component enabled right now (irrespective of
 * install/download status). Used to decide whether a component-backed tool
 * (currently only `bash`) should even be registered — see
 * `McpManager.isLocalToolEnabled`. Unlike `acquireRuntimeComponent`, this is
 * synchronous and side-effect free: it never triggers install or activation.
 *
 * Fails closed (`false`) when the service hasn't been wired yet — the same
 * "unavailable until proven available" default `acquireRuntimeComponent`
 * uses for its own not-wired case.
 */
export function isRuntimeComponentEnabled(id: RuntimeComponentId): boolean {
  if (testEnabledOverride) return testEnabledOverride(id)
  if (!service) return false
  return service
    .getSnapshot()
    .some((record) => record.descriptor.id === id && record.enabled)
}

export function setRuntimeComponentEnabledOverrideForTests(
  override: ((id: RuntimeComponentId) => boolean) | null,
): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Runtime component enabled overrides are test-only')
  }
  testEnabledOverride = override
}
