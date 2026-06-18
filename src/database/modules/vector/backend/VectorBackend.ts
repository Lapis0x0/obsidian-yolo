import { App } from 'obsidian'

import {
  EmbeddingDbStats,
  EmbeddingModelClient,
} from '../../../../types/embedding'
import { InsertEmbedding, SelectEmbedding } from '../../../schema'

export type VectorBackendKind = 'pglite' | 'sharded'
export type VectorVacuumMode = 'light' | 'full'

export type SimilaritySearchOptions = {
  minSimilarity: number
  limit: number
  scope?: {
    files: string[]
    folders: string[]
  }
}

export type VectorChunkRow = {
  id: number
  path: string
  mtime: number
  content_hash: string | null
  metadata: SelectEmbedding['metadata']
}

export interface VectorBackend {
  readonly kind: VectorBackendKind

  getFileMtimes(modelId: string): Promise<Map<string, number>>
  listChunksForPaths(modelId: string, paths: string[]): Promise<VectorChunkRow[]>
  deleteVectorsByIds(ids: number[]): Promise<void>
  deleteVectorsByPaths(modelId: string, paths: string[]): Promise<void>
  bumpMtimeByIds(updates: Array<{ id: number; mtime: number }>): Promise<void>
  insertVectors(data: InsertEmbedding[]): Promise<void>
  truncateModel(modelId: string): Promise<void>
  clearVectorsByModelIds(modelIds: string[]): Promise<void>
  vacuum(mode?: VectorVacuumMode): Promise<void>
  performSimilaritySearch(
    queryVector: number[],
    embeddingModel: EmbeddingModelClient,
    options: SimilaritySearchOptions,
  ): Promise<
    (Omit<SelectEmbedding, 'embedding'> & {
      similarity: number
    })[]
  >
  getEmbeddingStats(): Promise<EmbeddingDbStats[]>
}

export type VectorBackendFactoryOptions = {
  app: App
}
