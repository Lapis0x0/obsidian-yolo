import { Platform } from 'obsidian'

import type {
  EmbeddingSession,
  RuntimeComponentLease,
} from '../../runtime-components/contracts'
import {
  acquireRuntimeComponent,
  readRuntimeComponentAsset,
} from '../../runtime-components/runtimeComponentAccess'

import type { LocalEmbeddingCatalogEntry } from './catalog'
import type { LocalEmbeddingModelManager } from './manager'

/** One `session.embed()` call handles at most this many texts. */
const BATCH_SIZE = 16
/** Idle session teardown — releases the Worker and the `embedding-engine` lease. */
const IDLE_DISPOSE_MS = 10 * 60 * 1000

type QueueItem = Readonly<{
  text: string
  kind: 'query' | 'document'
  resolve: (vector: number[]) => void
  reject: (error: unknown) => void
}>

type SessionHandle = Readonly<{
  lease: RuntimeComponentLease<'embedding-engine'>
  session: EmbeddingSession
}>

export type LocalEmbeddingSessionClient = Readonly<{
  getEmbedding(
    text: string,
    options?: { kind?: 'query' | 'document' },
  ): Promise<number[]>
  dispose(): Promise<void>
}>

/**
 * Bridges one `EmbeddingModel` (providerId `yolo-local`) to the
 * `embedding-engine` runtime component: lazily acquires a Worker session on
 * first use, coalesces concurrent `getEmbedding` calls into batched
 * `session.embed()` calls, and tears the session down (releasing the
 * component lease) after `IDLE_DISPOSE_MS` of inactivity or when
 * `dispose()` is called explicitly (RAG engine rebuild / model switch — see
 * `ragEngine.ts`).
 *
 * Dimension validation is intentionally NOT done here — `getEmbeddingModelClient`
 * (`core/rag/embedding.ts`) applies the same hard check to every provider's
 * output, local or remote, so it isn't duplicated per-client.
 */
export function createLocalEmbeddingClient(options: {
  catalogEntry: LocalEmbeddingCatalogEntry
  manager: LocalEmbeddingModelManager
}): LocalEmbeddingSessionClient {
  const { catalogEntry, manager } = options

  let sessionPromise: Promise<SessionHandle> | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const queue: QueueItem[] = []
  let flushing = false
  let microtaskFlushScheduled = false

  function clearIdleTimer(): void {
    if (idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  function bumpIdleTimer(): void {
    clearIdleTimer()
    idleTimer = setTimeout(() => {
      void disposeSession()
    }, IDLE_DISPOSE_MS)
  }

  async function createSession(): Promise<SessionHandle> {
    if (!Platform.isDesktop) {
      throw new Error(
        'Local embedding models are only available on desktop Obsidian.',
      )
    }
    if (manager.getState(catalogEntry.id).status !== 'ready') {
      throw new Error(
        `Local embedding model "${catalogEntry.displayName}" is not installed. Download it first.`,
      )
    }

    const lease = await acquireRuntimeComponent('embedding-engine')
    try {
      const probe = lease.api.probeEnvironment()
      if (!probe.ok) {
        throw new Error(
          `Local embedding engine is unavailable in this environment: ${probe.reason}`,
        )
      }
      const session = await lease.api.createSession({
        loadWasm: (name, signal) =>
          readRuntimeComponentAsset('embedding-engine', name).then((bytes) => {
            if (signal?.aborted) {
              throw new DOMException(
                'Embedding session creation aborted',
                'AbortError',
              )
            }
            return bytes
          }),
        loadModelFile: (file, signal) =>
          manager.readModelFile(catalogEntry, file, signal),
        spec: {
          dimension: catalogEntry.dimension,
          pooling: catalogEntry.pooling,
          normalize: catalogEntry.normalize,
          maxTokens: catalogEntry.maxTokens,
        },
        device: 'wasm',
      })
      return { lease, session }
    } catch (error) {
      lease.release()
      throw error
    }
  }

  async function ensureSession(): Promise<EmbeddingSession> {
    clearIdleTimer()
    if (!sessionPromise) {
      sessionPromise = createSession().catch((error: unknown) => {
        sessionPromise = null
        throw error
      })
    }
    const handle = await sessionPromise
    return handle.session
  }

  async function disposeSession(): Promise<void> {
    clearIdleTimer()
    const pending = sessionPromise
    sessionPromise = null
    if (!pending) return
    try {
      const { lease, session } = await pending
      await session.dispose()
      lease.release()
    } catch {
      // Session never finished initializing (or already failed) — nothing
      // live to release beyond the promise reference cleared above.
    }
  }

  function applyPrefix(text: string, kind: 'query' | 'document'): string {
    const prefixes = catalogEntry.prefixes
    if (!prefixes) return text
    const prefix = kind === 'query' ? prefixes.query : prefixes.document
    return prefix ? `${prefix}${text}` : text
  }

  async function flush(): Promise<void> {
    if (flushing) return
    if (queue.length === 0) return
    flushing = true
    const batch = queue.splice(0, BATCH_SIZE)
    try {
      const session = await ensureSession()
      const texts = batch.map((item) => applyPrefix(item.text, item.kind))
      const vectors = await session.embed(texts)
      if (vectors.length !== batch.length) {
        throw new Error(
          `Embedding engine returned ${vectors.length} vectors for ${batch.length} inputs`,
        )
      }
      batch.forEach((item, index) => {
        item.resolve(Array.from(vectors[index]))
      })
    } catch (error) {
      for (const item of batch) item.reject(error)
    } finally {
      flushing = false
      // Only worth an idle-teardown timer if a session actually exists (or
      // is being created) to tear down — e.g. a "model not installed"
      // failure never gets one this way, instead of scheduling a 10-minute
      // no-op.
      if (sessionPromise) bumpIdleTimer()
      if (queue.length > 0) void flush()
    }
  }

  function scheduleFlush(): void {
    if (flushing) return
    if (queue.length >= BATCH_SIZE) {
      void flush()
      return
    }
    if (microtaskFlushScheduled) return
    microtaskFlushScheduled = true
    void Promise.resolve().then(() => {
      microtaskFlushScheduled = false
      if (!flushing) void flush()
    })
  }

  return Object.freeze({
    getEmbedding(
      text: string,
      embedOptions?: { kind?: 'query' | 'document' },
    ): Promise<number[]> {
      return new Promise<number[]>((resolve, reject) => {
        queue.push({
          text,
          kind: embedOptions?.kind ?? 'document',
          resolve,
          reject,
        })
        scheduleFlush()
      })
    },
    dispose: disposeSession,
  })
}
