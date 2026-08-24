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
  /**
   * Tears down the live Worker session now (same effect as the idle timer
   * eventually firing) without invalidating the client — the next
   * `getEmbedding()` call transparently recreates one. For a cancelled
   * index run on a heavy model (e.g. Qwen3-Embedding, several GB resident),
   * waiting out the full `IDLE_DISPOSE_MS` window after cancel just holds
   * that memory for nothing.
   */
  releaseIdleSession(): Promise<void>
}>

/**
 * One Worker session per catalog id, shared and refcounted across every
 * `LocalEmbeddingSessionClient` for that model. A KB's `RAGEngine` acquires
 * one on `createLocalEmbeddingClient()` and releases it on `dispose()`;
 * multiple KBs indexing with the same model (or a settings save that
 * recreates the client — see `ragEngine.ts`) share the same underlying
 * Worker instead of each spinning up their own (a `bge-m3` session alone is
 * ~570MB of weights).
 */
type SharedSession = {
  readonly catalogEntry: LocalEmbeddingCatalogEntry
  readonly manager: LocalEmbeddingModelManager
  refCount: number
  sessionPromise: Promise<SessionHandle> | null
  idleTimer: ReturnType<typeof setTimeout> | null
  readonly queue: QueueItem[]
  flushing: boolean
  microtaskFlushScheduled: boolean
}

const sharedSessions = new Map<string, SharedSession>()

function acquireSharedSession(
  catalogEntry: LocalEmbeddingCatalogEntry,
  manager: LocalEmbeddingModelManager,
): SharedSession {
  const existing = sharedSessions.get(catalogEntry.id)
  if (existing) {
    existing.refCount += 1
    return existing
  }
  const shared: SharedSession = {
    catalogEntry,
    manager,
    refCount: 1,
    sessionPromise: null,
    idleTimer: null,
    queue: [],
    flushing: false,
    microtaskFlushScheduled: false,
  }
  sharedSessions.set(catalogEntry.id, shared)
  return shared
}

/** Releases one reference; tears the session down immediately once none remain. */
async function releaseSharedSession(shared: SharedSession): Promise<void> {
  shared.refCount -= 1
  if (shared.refCount > 0) return
  if (sharedSessions.get(shared.catalogEntry.id) === shared) {
    sharedSessions.delete(shared.catalogEntry.id)
  }
  await teardownSession(shared)
}

function clearIdleTimer(shared: SharedSession): void {
  if (shared.idleTimer !== null) {
    clearTimeout(shared.idleTimer)
    shared.idleTimer = null
  }
}

function bumpIdleTimer(shared: SharedSession): void {
  clearIdleTimer(shared)
  shared.idleTimer = setTimeout(() => {
    void teardownSession(shared)
  }, IDLE_DISPOSE_MS)
}

async function createSession(shared: SharedSession): Promise<SessionHandle> {
  const { catalogEntry, manager } = shared
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
        dtype: catalogEntry.dtype,
      },
      device: 'wasm',
    })
    return { lease, session }
  } catch (error) {
    lease.release()
    throw error
  }
}

async function ensureSession(shared: SharedSession): Promise<EmbeddingSession> {
  clearIdleTimer(shared)
  // A cached session is only trustworthy while the manager still reports
  // the model `ready` — deleting it (or "remove all") while a session is
  // loaded/idle must not leave a live Worker that keeps happily embedding
  // against files the manager just erased, with the UI showing "not
  // downloaded" the whole time. Re-check on every acquire, not just at
  // session-creation time.
  if (
    shared.sessionPromise &&
    shared.manager.getState(shared.catalogEntry.id).status !== 'ready'
  ) {
    await teardownSession(shared)
  }
  if (!shared.sessionPromise) {
    shared.sessionPromise = createSession(shared).catch((error: unknown) => {
      shared.sessionPromise = null
      throw error
    })
  }
  const handle = await shared.sessionPromise
  return handle.session
}

/**
 * Tears the current session down (if any) and clears it so the next
 * `ensureSession()` call lazily recreates one. Safe to call any number of
 * times, including concurrently.
 */
async function teardownSession(shared: SharedSession): Promise<void> {
  clearIdleTimer(shared)
  const pending = shared.sessionPromise
  shared.sessionPromise = null
  if (!pending) return
  let handle: SessionHandle
  try {
    handle = await pending
  } catch {
    // Session never finished initializing (or already failed) — nothing
    // live to release beyond the promise reference cleared above.
    return
  }
  try {
    await handle.session.dispose()
  } catch {
    // Teardown is best-effort cleanup — a Worker that failed to shut down
    // cleanly isn't something any caller (RAGEngine's fire-and-forget
    // `dispose()`, `health-check.ts`'s `finally`) should have to handle.
    // The lease still gets released below regardless.
  } finally {
    // `session.dispose()` throwing must not leak the runtime-component
    // lease — an unreleased lease blocks the component's quiesce/drain on
    // host shutdown or component disable indefinitely.
    handle.lease.release()
  }
}

function applyPrefix(
  catalogEntry: LocalEmbeddingCatalogEntry,
  text: string,
  kind: 'query' | 'document',
): string {
  const prefixes = catalogEntry.prefixes
  if (!prefixes) return text
  const prefix = kind === 'query' ? prefixes.query : prefixes.document
  return prefix ? `${prefix}${text}` : text
}

async function flush(shared: SharedSession): Promise<void> {
  if (shared.flushing) return
  if (shared.queue.length === 0) return
  shared.flushing = true
  const batch = shared.queue.splice(0, BATCH_SIZE)
  try {
    const session = await ensureSession(shared)
    const texts = batch.map((item) =>
      applyPrefix(shared.catalogEntry, item.text, item.kind),
    )
    let vectors: Awaited<ReturnType<EmbeddingSession['embed']>>
    try {
      vectors = await session.embed(texts)
      if (vectors.length !== batch.length) {
        throw new Error(
          `Embedding engine returned ${vectors.length} vectors for ${batch.length} inputs`,
        )
      }
    } catch (embedError) {
      // The Worker behind this session is no longer trustworthy after a
      // failed/short `embed()` response — drop it so the next flush
      // creates a fresh session instead of repeatedly hitting (or hanging
      // on) a broken one until the idle timer eventually recycles it.
      await teardownSession(shared)
      throw embedError
    }
    batch.forEach((item, index) => {
      item.resolve(Array.from(vectors[index]))
    })
  } catch (error) {
    for (const item of batch) item.reject(error)
  } finally {
    shared.flushing = false
    // Only worth an idle-teardown timer if a session actually exists (or
    // is being created) to tear down — e.g. a "model not installed"
    // failure never gets one this way, instead of scheduling a 10-minute
    // no-op.
    if (shared.sessionPromise) bumpIdleTimer(shared)
    if (shared.queue.length > 0) void flush(shared)
  }
}

function scheduleFlush(shared: SharedSession): void {
  if (shared.flushing) return
  if (shared.queue.length >= BATCH_SIZE) {
    void flush(shared)
    return
  }
  if (shared.microtaskFlushScheduled) return
  shared.microtaskFlushScheduled = true
  void Promise.resolve().then(() => {
    shared.microtaskFlushScheduled = false
    if (!shared.flushing) void flush(shared)
  })
}

/**
 * Bridges one `EmbeddingModel` (providerId `yolo-local`) to the
 * `embedding-engine` runtime component. The returned handle is lightweight:
 * the actual Worker session lives in a module-level registry shared and
 * refcounted by catalog id (see `SharedSession` above), acquired on creation
 * and released on `dispose()`.
 *
 * `dispose()` is idempotent, and every `getEmbedding()` call after it
 * rejects immediately rather than silently re-acquiring a session — a
 * disposed client is a client the caller is done with (RAG engine rebuild /
 * model switch — see `ragEngine.ts`).
 *
 * Dimension validation is intentionally NOT done here — `getEmbeddingModelClient`
 * (`core/rag/embedding.ts`) applies the same hard check to every provider's
 * output, local or remote, so it isn't duplicated per-client.
 */
export function createLocalEmbeddingClient(options: {
  catalogEntry: LocalEmbeddingCatalogEntry
  manager: LocalEmbeddingModelManager
}): LocalEmbeddingSessionClient {
  const shared = acquireSharedSession(options.catalogEntry, options.manager)
  let disposed = false
  let releasePromise: Promise<void> | null = null

  return Object.freeze({
    getEmbedding(
      text: string,
      embedOptions?: { kind?: 'query' | 'document' },
    ): Promise<number[]> {
      if (disposed) {
        return Promise.reject(
          new Error('Local embedding client has been disposed'),
        )
      }
      return new Promise<number[]>((resolve, reject) => {
        shared.queue.push({
          text,
          kind: embedOptions?.kind ?? 'document',
          resolve,
          reject,
        })
        scheduleFlush(shared)
      })
    },
    dispose(): Promise<void> {
      if (disposed) return releasePromise ?? Promise.resolve()
      disposed = true
      releasePromise = releaseSharedSession(shared)
      return releasePromise
    },
    releaseIdleSession(): Promise<void> {
      if (disposed) return Promise.resolve()
      return teardownSession(shared)
    },
  })
}
