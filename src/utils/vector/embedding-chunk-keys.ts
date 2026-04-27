import type { VectorMetaData } from '../../database/schema'

/** Identity of a chunk within one file: md `start:end`, pdf `page:start:end`. */
export function embeddingChunkLineKey(meta: VectorMetaData): string {
  if (meta.page !== undefined) {
    return `${meta.page}:${meta.startLine}:${meta.endLine}`
  }
  return `${meta.startLine}:${meta.endLine}`
}
