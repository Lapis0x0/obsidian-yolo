import { PgliteDatabase } from 'drizzle-orm/pglite'
import { App } from 'obsidian'

import {
  EmbeddingDbStats,
  EmbeddingModelClient,
} from '../../../types/embedding'
import { InsertEmbedding, SelectEmbedding } from '../../schema'
import { PgliteVectorBackend } from './backend/PgliteVectorBackend'
import {
  SimilaritySearchOptions,
  VectorBackend,
  VectorBackendKind,
  VectorVacuumMode,
  VectorChunkRow,
} from './backend/VectorBackend'

export class VectorRepository {
  private readonly backend: VectorBackend

  constructor({
    app,
    db,
    backend,
  }: {
    app: App
    db: PgliteDatabase | null
    backend?: VectorBackend
  }) {
    this.backend = backend ?? new PgliteVectorBackend(app, db)
  }

  getBackendKind(): VectorBackendKind {
    return this.backend.kind
  }

  async getFileMtimes(modelId: string): Promise<Map<string, number>> {
    return this.backend.getFileMtimes(modelId)
  }

  async listChunksForPaths(
    modelId: string,
    paths: string[],
  ): Promise<VectorChunkRow[]> {
    return this.backend.listChunksForPaths(modelId, paths)
  }

  async deleteVectorsByIds(ids: number[]): Promise<void> {
    return this.backend.deleteVectorsByIds(ids)
  }

  async deleteVectorsByPaths(modelId: string, paths: string[]): Promise<void> {
    return this.backend.deleteVectorsByPaths(modelId, paths)
  }

  async bumpMtimeByIds(
    updates: Array<{ id: number; mtime: number }>,
  ): Promise<void> {
    return this.backend.bumpMtimeByIds(updates)
  }

  async insertVectors(data: InsertEmbedding[]): Promise<void> {
    return this.backend.insertVectors(data)
  }

  async truncateModel(modelId: string): Promise<void> {
    return this.backend.truncateModel(modelId)
  }

  async clearVectorsByModelIds(modelIds: string[]): Promise<void> {
    return this.backend.clearVectorsByModelIds(modelIds)
  }

  async vacuum(mode: VectorVacuumMode = 'light'): Promise<void> {
    return this.backend.vacuum(mode)
  }

  async performSimilaritySearch(
    queryVector: number[],
    embeddingModel: EmbeddingModelClient,
    options: SimilaritySearchOptions,
  ): Promise<
    (Omit<SelectEmbedding, 'embedding'> & {
      similarity: number
    })[]
  > {
    return this.backend.performSimilaritySearch(
      queryVector,
      embeddingModel,
      options,
    )
  }

  async getEmbeddingStats(): Promise<EmbeddingDbStats[]> {
    return this.backend.getEmbeddingStats()
  }
}
