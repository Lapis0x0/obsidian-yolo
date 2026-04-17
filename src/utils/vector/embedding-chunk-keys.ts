import type { VectorMetaData } from '../../database/schema'

/** Staging / resume fingerprint: md `start:end:hash`, pdf `page:start:end:hash`. */
export function embeddingChunkFingerprint(
  meta: VectorMetaData,
  content_hash: string,
): string {
  if (meta.page !== undefined) {
    return `${meta.page}:${meta.startLine}:${meta.endLine}:${content_hash}`
  }
  return `${meta.startLine}:${meta.endLine}:${content_hash}`
}

/** Incremental index map key for a chunk row. */
export function embeddingChunkLineKey(meta: VectorMetaData): string {
  if (meta.page !== undefined) {
    return `${meta.page}:${meta.startLine}:${meta.endLine}`
  }
  return `${meta.startLine}:${meta.endLine}`
}
