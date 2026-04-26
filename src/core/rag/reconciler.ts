import type { VectorMetaData } from '../../database/schema'
import { embeddingChunkLineKey } from '../../utils/vector/embedding-chunk-keys'

/**
 * The "shape" of a reconcile pass. Determines how the universe of paths is
 * computed before chunkifying and diffing.
 *
 * - `all`: scan the whole vault (filtered by patterns / indexPdf).
 * - `paths`: only consider these paths. Paths outside this list are left
 *   alone, even if they would otherwise be in or out of scope.
 */
export type ReconcileScope =
  | { kind: 'all' }
  | { kind: 'paths'; paths: string[] }

/**
 * A chunk that *should* exist in the index for a given file under the
 * current configuration.
 */
export type DesiredChunk = {
  path: string
  content: string
  contentHash: string
  metadata: VectorMetaData
  mtime: number
}

/**
 * A chunk that currently exists in the index. `id` is the DB primary key
 * used for deletion / mtime updates.
 */
export type ActualChunk = {
  id: number
  path: string
  contentHash: string | null
  metadata: VectorMetaData
  mtime: number
}

export type ReconcilePlan = {
  /** Rows to delete (no longer desired, or content changed). */
  toDeleteIds: number[]
  /** Chunks to embed and insert. */
  toEmbed: DesiredChunk[]
  /** Existing rows whose mtime should be bumped (content unchanged). */
  toBumpMtime: Array<{ id: number; mtime: number }>
  /** Number of chunks fully reused without re-embedding. */
  reusedCount: number
}

/**
 * Identity within a path: line range (markdown) or page+line range (pdf).
 * Two chunks at the same identity are considered the "same slot".
 */
const identityWithinPath = (meta: VectorMetaData): string =>
  embeddingChunkLineKey(meta)

const fullIdentity = (path: string, meta: VectorMetaData): string =>
  `${path}#${identityWithinPath(meta)}`

/**
 * Pure diff: produces a plan of deletions, embeddings, and mtime bumps so
 * that the index becomes equal to `desired` for all paths covered by either
 * `desired` or `actual`.
 *
 * Caller is responsible for narrowing `actual` to the same scope as
 * `desired`. Rows outside that scope must NOT appear in `actual`, or they
 * will be erroneously deleted.
 */
export function planReconcile(
  desired: DesiredChunk[],
  actual: ActualChunk[],
): ReconcilePlan {
  const desiredByIdentity = new Map<string, DesiredChunk>()
  for (const d of desired) {
    desiredByIdentity.set(fullIdentity(d.path, d.metadata), d)
  }

  // Bucket actual rows by their identity. For unique-identity rows we can
  // make a direct decision; for collisions (rare — same file/line range
  // duplicated due to legacy data) we keep one and delete the rest.
  const actualByIdentity = new Map<string, ActualChunk[]>()
  for (const a of actual) {
    const key = fullIdentity(a.path, a.metadata)
    const bucket = actualByIdentity.get(key)
    if (bucket) {
      bucket.push(a)
    } else {
      actualByIdentity.set(key, [a])
    }
  }

  const toDeleteIds: number[] = []
  const toEmbed: DesiredChunk[] = []
  const toBumpMtime: Array<{ id: number; mtime: number }> = []
  let reusedCount = 0

  // Pass 1: every actual that has no matching desired identity → delete.
  for (const [key, rows] of actualByIdentity) {
    const desiredChunk = desiredByIdentity.get(key)
    if (!desiredChunk) {
      for (const row of rows) toDeleteIds.push(row.id)
      continue
    }
    // Keep one row whose hash matches (if any), delete the rest. If none
    // match, all are stale → delete all and re-embed.
    const matching = rows.find(
      (row) => row.contentHash === desiredChunk.contentHash,
    )
    if (matching) {
      reusedCount += 1
      if (matching.mtime !== desiredChunk.mtime) {
        toBumpMtime.push({ id: matching.id, mtime: desiredChunk.mtime })
      }
      for (const row of rows) {
        if (row.id !== matching.id) toDeleteIds.push(row.id)
      }
    } else {
      for (const row of rows) toDeleteIds.push(row.id)
    }
  }

  // Pass 2: every desired that lacks a reusable actual → embed.
  for (const [key, desiredChunk] of desiredByIdentity) {
    const rows = actualByIdentity.get(key)
    if (!rows) {
      toEmbed.push(desiredChunk)
      continue
    }
    const matching = rows.find(
      (row) => row.contentHash === desiredChunk.contentHash,
    )
    if (!matching) {
      toEmbed.push(desiredChunk)
    }
  }

  return { toDeleteIds, toEmbed, toBumpMtime, reusedCount }
}
