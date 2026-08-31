import type { LocalEmbeddingModelManager } from './manager'

/**
 * Module-level singleton getter/setter, mirroring
 * `runtime-components/runtimeComponentAccess.ts`: `getEmbeddingModelClient`
 * (`core/rag/embedding.ts`) is a plain function, not a class method, so it
 * has no constructor to inject the manager into. `main.ts` wires the real
 * instance in during plugin load via `setLocalEmbeddingModelManager`.
 *
 * `null` (not "unavailable" thrown here) on mobile / before wiring — callers
 * decide how to surface that (see `client.ts`'s "not available on this
 * platform" error), matching `isRuntimeComponentEnabled`'s "fails closed"
 * precedent rather than `acquireRuntimeComponent`'s "throws" one, since a
 * missing manager is an expected, common state (every mobile session) rather
 * than a wiring bug.
 */
let manager: LocalEmbeddingModelManager | null = null

export function setLocalEmbeddingModelManager(
  next: LocalEmbeddingModelManager | null,
): void {
  manager = next
}

export function getLocalEmbeddingModelManager(): LocalEmbeddingModelManager | null {
  return manager
}
