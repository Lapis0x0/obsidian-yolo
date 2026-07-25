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
