import { App, normalizePath } from 'obsidian'
import initSqlJs, { SqlJsStatic } from 'sql.js'

import {
  EmbeddingDbStats,
  EmbeddingModelClient,
} from '../../../../../types/embedding'
import {
  InsertEmbedding,
  SelectEmbedding,
  VectorMetaData,
} from '../../../../schema'
import {
  SimilaritySearchOptions,
  VectorBackend,
  VectorChunkRow,
  VectorVacuumMode,
} from '../VectorBackend'
import { parseShardedManifest } from './shardedManifest'
import {
  getShardedIndexRoot,
  getShardedManifestPath,
  getShardedShardRoot,
  getShardedStagedManifestPath,
  getShardedTempShardRoot,
} from './shardedPaths'
import { ShardedManifest } from './types'

type TempShardRow = {
  chunkId: string
  path: string
  mtime: number
  contentHash: string | null
  startOffset?: number
  endOffset?: number
  startLine: number
  endLine: number
  page?: number
  text: string
  metadata: VectorMetaData
  embedding: number[]
}

type StoredChunkRow = {
  row_id: number
  chunk_id: string
  file_path: string
  file_mtime: number
  file_content_hash: string | null
  chunk_content_hash: string | null
  start_offset: number | null
  end_offset: number | null
  start_line: number
  end_line: number
  page: number | null
  text: string
  metadata_json: VectorMetaData
}

type ShardMeta = {
  shardId: string
  modelNamespace: string
  dimension: number
  vectorCount: number
  vectorBlockSize: number
  vectorBlockCount: number
  filePaths: string[]
  pathPrefixes: string[]
}

type StoredIndexData = {
  rowNorms: Float32Array
  clusterCentroids: Float32Array
  postingOffsets: Uint32Array
  postingRowIds: Uint32Array
}

type SearchableChunkRow = {
  row_id: number
  file_path: string
  file_mtime: number
  chunk_content_hash: string | null
  text: string
  metadata_json: VectorMetaData
}

export type SearchPhaseTimings = {
  manifestLoadMs: number
  shardPrefilterMs: number
  indexLoadMs: number
  candidateSelectionMs: number
  tombstoneLoadMs: number
  rowBlockLoadMs: number
  vectorBlockLoadMs: number
  rerankMs: number
  dedupeSortMs: number
}

type CachedManifest = {
  raw: string
  parsed: ShardedManifest
}

type ShardScopedRow = {
  shardId: string
  shardRoot: string
  shardDimension: number
  row: StoredChunkRow
}

const INDEX_MAGIC = 'YOLOIDX'
const INDEX_VERSION = 1
const INDEX_HEADER_BYTES = 16
const TOMBSTONE_MAGIC = 'YOLOTMB'
const TOMBSTONE_VERSION = 1
const TOMBSTONE_HEADER_BYTES = 12
const GLOBAL_ROW_ID_FACTOR = 1_000_000_000

let sqlJsPromise: Promise<SqlJsStatic> | null = null

const getSqlJs = async (): Promise<SqlJsStatic> => {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs()
  }
  return sqlJsPromise
}

export class ShardedVectorBackend implements VectorBackend {
  readonly kind = 'sharded' as const
  private manifestCache: CachedManifest | null = null
  private lastSearchPhaseTimings: SearchPhaseTimings | null = null
  private readonly shardMetaCache = new Map<string, Promise<ShardMeta>>()
  private readonly indexCache = new Map<string, Promise<StoredIndexData>>()
  private readonly chunkRowsCache = new Map<string, Promise<StoredChunkRow[]>>()
  private readonly searchRowsCache = new Map<string, Promise<SearchableChunkRow[]>>()
  private readonly vectorBytesCache = new Map<string, Promise<ArrayBuffer>>()
  private readonly tombstoneCache = new Map<string, Promise<Set<number>>>()

  constructor(
    private readonly options: {
      app: App
      baseDir: string
      maxVectorsPerShard?: number
      maxConcurrentShardQueries?: number
      targetCentroidsPerShard?: number
      maxProbeClusters?: number
      adaptiveProbeScale?: number
      vectorBlockSize?: number
      compactDeadRatio?: number
    },
  ) {}

  getRootPath(): string {
    return getShardedIndexRoot(normalizePath(this.options.baseDir))
  }

  getManifestPath(): string {
    return getShardedManifestPath(normalizePath(this.options.baseDir))
  }

  getStagedManifestPath(): string {
    return getShardedStagedManifestPath(normalizePath(this.options.baseDir))
  }

  getTempShardPath(
    modelNamespace: string,
    runId: string,
    shardId: string,
  ): string {
    return getShardedTempShardRoot(
      normalizePath(this.options.baseDir),
      modelNamespace,
      runId,
      shardId,
    )
  }

  async ensureRootLayout(): Promise<void> {
    const root = this.getRootPath()
    const modelsDir = `${root}/models`
    if (!(await this.options.app.vault.adapter.exists(root))) {
      await this.options.app.vault.adapter.mkdir(root)
    }
    if (!(await this.options.app.vault.adapter.exists(modelsDir))) {
      await this.options.app.vault.adapter.mkdir(modelsDir)
    }
  }

  async loadManifest(): Promise<ShardedManifest | null> {
    const manifestPath = this.getManifestPath()
    if (!(await this.options.app.vault.adapter.exists(manifestPath))) {
      this.manifestCache = null
      return null
    }
    const raw = await this.options.app.vault.adapter.read(manifestPath)
    if (this.manifestCache?.raw === raw) {
      return this.manifestCache.parsed
    }
    const parsed = parseShardedManifest(JSON.parse(raw))
    this.manifestCache = {
      raw,
      parsed,
    }
    return parsed
  }

  async writeStagedManifest(manifest: ShardedManifest): Promise<void> {
    await this.ensureRootLayout()
    await this.options.app.vault.adapter.write(
      this.getStagedManifestPath(),
      JSON.stringify(manifest, null, 2),
    )
  }

  async writeActiveManifest(manifest: ShardedManifest): Promise<void> {
    await this.ensureRootLayout()
    const raw = JSON.stringify(manifest, null, 2)
    await this.options.app.vault.adapter.write(this.getManifestPath(), raw)
    this.manifestCache = {
      raw,
      parsed: manifest,
    }
  }

  async writeTempShardArtifacts(input: {
    modelNamespace: string
    runId: string
    shardId: string
    rows: TempShardRow[]
  }): Promise<void> {
    const shardPath = this.getTempShardPath(
      input.modelNamespace,
      input.runId,
      input.shardId,
    )
    await this.ensureDirChain(shardPath)
    const vectorBlockSize = this.getVectorBlockSize()
    const vectorBlockCount = Math.ceil(input.rows.length / vectorBlockSize)

    const chunkRows = input.rows.map((row, index) => ({
      row_id: index,
      chunk_id: row.chunkId,
      file_path: row.path,
      file_mtime: row.mtime,
      file_content_hash: row.contentHash,
      chunk_content_hash: row.contentHash,
      start_offset: row.startOffset ?? null,
      end_offset: row.endOffset ?? null,
      start_line: row.startLine,
      end_line: row.endLine,
      page: row.page ?? null,
      text: row.text,
      metadata_json: row.metadata,
    }))

    const sqlJs = await getSqlJs()
    const db = new sqlJs.Database()
    db.run(`
      CREATE TABLE chunks (
        row_id INTEGER PRIMARY KEY,
        chunk_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_mtime INTEGER NOT NULL,
        file_content_hash TEXT,
        chunk_content_hash TEXT,
        start_offset INTEGER,
        end_offset INTEGER,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        page INTEGER,
        text TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );
    `)
    const stmt = db.prepare(`
      INSERT INTO chunks (
        row_id,
        chunk_id,
        file_path,
        file_mtime,
        file_content_hash,
        chunk_content_hash,
        start_offset,
        end_offset,
        start_line,
        end_line,
        page,
        text,
        metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    chunkRows.forEach((row) => {
      stmt.run([
        row.row_id,
        row.chunk_id,
        row.file_path,
        row.file_mtime,
        row.file_content_hash,
        row.chunk_content_hash,
        row.start_offset,
        row.end_offset,
        row.start_line,
        row.end_line,
        row.page,
        row.text,
        JSON.stringify(row.metadata_json),
      ])
    })
    stmt.free()
    const sqliteBytes = db.export()
    db.close()

    await this.options.app.vault.adapter.writeBinary(
      `${shardPath}/chunks.sqlite`,
      sqliteBytes.buffer.slice(
        sqliteBytes.byteOffset,
        sqliteBytes.byteOffset + sqliteBytes.byteLength,
      ),
    )

    const dimension = input.rows[0]?.embedding.length ?? 0
    await this.writeVectorBlocks({
      shardPath,
      rows: input.rows,
      chunkRows,
      dimension,
      vectorBlockSize,
    })

    await this.options.app.vault.adapter.writeBinary(
      `${shardPath}/index.bin`,
      this.buildIndexBytes({
        dimension,
        vectorCount: input.rows.length,
        rows: input.rows,
      }),
    )

    await this.options.app.vault.adapter.writeBinary(
      `${shardPath}/tombstones.bin`,
      this.buildTombstonesBytes([]),
    )

    await this.options.app.vault.adapter.write(
      `${shardPath}/shard.meta.json`,
      JSON.stringify(
        this.buildShardMeta({
          shardId: input.shardId,
          modelNamespace: input.modelNamespace,
          dimension,
          rows: input.rows,
          vectorBlockSize,
          vectorBlockCount,
        }),
        null,
        2,
      ),
    )
  }

  async getFileMtimes(_modelId: string): Promise<Map<string, number>> {
    const rows = await this.loadRowsForModel(_modelId)
    const mtimeMap = new Map<string, number>()
    for (const row of rows) {
      const existing = mtimeMap.get(row.file_path)
      if (existing === undefined || row.file_mtime > existing) {
        mtimeMap.set(row.file_path, row.file_mtime)
      }
    }
    return mtimeMap
  }

  async listChunksForPaths(
    modelId: string,
    paths: string[],
  ): Promise<VectorChunkRow[]> {
    if (paths.length === 0) {
      return []
    }
    const pathSet = new Set(paths)
    const rows = await this.loadRowsForModelWithShard(modelId)
    return rows
      .filter((item) => pathSet.has(item.row.file_path))
      .map((item) => ({
        id: this.encodeGlobalRowId(item.shardId, item.row.row_id),
        path: item.row.file_path,
        mtime: item.row.file_mtime,
        content_hash: item.row.chunk_content_hash,
        metadata: item.row.metadata_json,
      }))
  }

  async deleteVectorsByIds(ids: number[]): Promise<void> {
    if (ids.length === 0) {
      return
    }
    const selections = this.groupGlobalRowIds(ids)
    await this.markTombstonesBySelection(selections)
  }

  async deleteVectorsByPaths(
    modelId: string,
    paths: string[],
  ): Promise<void> {
    if (paths.length === 0) {
      return
    }
    const manifest = await this.loadManifest()
    if (!manifest) {
      return
    }
    if (!this.modelMatchesNamespace(manifest.activeModel, modelId)) {
      return
    }

    const rows = await this.loadRowsForModelWithShard(modelId)
    const pathSet = new Set(paths)
    const selections = new Map<string, Set<number>>()
    for (const item of rows) {
      if (!pathSet.has(item.row.file_path)) {
        continue
      }
      const bucket = selections.get(item.shardId) ?? new Set<number>()
      bucket.add(item.row.row_id)
      selections.set(item.shardId, bucket)
    }
    await this.markTombstonesBySelection(selections)
  }

  async bumpMtimeByIds(
    updates: Array<{ id: number; mtime: number }>,
  ): Promise<void> {
    if (updates.length === 0) {
      return
    }
    const updatesByShard = new Map<string, Map<number, number>>()
    for (const update of updates) {
      const decoded = this.decodeGlobalRowId(update.id)
      let shardUpdates = updatesByShard.get(decoded.shardId)
      if (!shardUpdates) {
        shardUpdates = new Map<number, number>()
        updatesByShard.set(decoded.shardId, shardUpdates)
      }
      shardUpdates.set(decoded.rowId, update.mtime)
    }
    const manifest = await this.loadManifest()
    if (!manifest) {
      return
    }
    const updatedShards: ShardedManifest['shards'] = []
    for (const shard of manifest.shards) {
      if (shard.state !== 'ready') {
        updatedShards.push(shard)
        continue
      }
      const rowUpdates = updatesByShard.get(shard.id)
      if (!rowUpdates) {
        updatedShards.push(shard)
        continue
      }
      const shardRoot = `${this.getRootPath()}/${shard.relativePath}`
      const shardRows = await this.readStoredChunkRows(`${shardRoot}/chunks.sqlite`)
      const rewrittenRows = shardRows.map((row) => {
        const mtime = rowUpdates.get(row.row_id)
        if (mtime === undefined) {
          return row
        }
        return {
          ...row,
          file_mtime: mtime,
        }
      })
      const rebuiltRows = await this.rebuildTempRowsFromStoredRows({
        shardRoot,
        storedRows: rewrittenRows,
        dimension: shard.dimension,
      })
      await this.replaceReadyShard({
        manifest,
        shard,
        shardRoot,
        rebuiltRows,
      })
      updatedShards.push({
        ...shard,
        vectorCount: rebuiltRows.length,
      })
    }
    await this.writeActiveManifest({
      ...manifest,
      updatedAt: Date.now(),
      shards: updatedShards,
    })
    this.clearAllShardCaches()
  }

  async insertVectors(data: InsertEmbedding[]): Promise<void> {
    if (data.length === 0) {
      return
    }

    const first = data[0]
    if (!first.embedding) {
      throw new Error(
        'ShardedVectorBackend insertVectors requires concrete embedding arrays',
      )
    }
    const modelNamespace = `${first.model}@${first.dimension}`
    const normalizedRows = data.map((row) => {
      if (!row.embedding) {
        throw new Error(
          'ShardedVectorBackend insertVectors requires concrete embedding arrays',
        )
      }
      return {
        ...row,
        embedding: row.embedding,
      }
    })
    const invalidRow = normalizedRows.find(
      (row) =>
        row.model !== first.model ||
        row.dimension !== first.dimension ||
        row.embedding.length !== first.dimension,
    )
    if (invalidRow) {
      throw new Error(
        'ShardedVectorBackend insertVectors requires one model/dimension per rebuild batch',
      )
    }

    await this.ensureRootLayout()
    const existingManifest = await this.loadManifest()
    const manifest = this.createManifestForInsert({
      existingManifest,
      modelNamespace,
    })
    const pendingRows = [...normalizedRows]

    const nextShardNumericId = manifest.shards.reduce((maxId, shard) => {
      const numericId = Number.parseInt(shard.id, 10)
      return Number.isFinite(numericId) ? Math.max(maxId, numericId) : maxId
    }, 0)
    const shardBatches = this.partitionRows(pendingRows)
    for (const [index, batch] of shardBatches.entries()) {
      const shardId = `${nextShardNumericId + index + 1}`.padStart(6, '0')
      const shardRoot = getShardedShardRoot(
        normalizePath(this.options.baseDir),
        modelNamespace,
        shardId,
      )
      await this.removePathIfExists(shardRoot)
      await this.ensureDirChain(shardRoot)
      await this.writeTempShardArtifacts({
        modelNamespace,
        runId: 'ready',
        shardId,
        rows: this.buildTempRowsFromBatch(batch),
      })

      const tempRoot = this.getTempShardPath(modelNamespace, 'ready', shardId)
      await this.copyShardArtifacts(tempRoot, shardRoot)
      await this.removePathIfExists(tempRoot)

      manifest.shards.push({
        id: shardId,
        relativePath: `models/${modelNamespace}/shards/${shardId}`,
        state: 'ready',
        dimension: first.dimension,
        vectorCount: batch.length,
        checksums: {
          chunksSqlite: 'sha256:pending',
          vectorsF32: 'sha256:pending',
          indexBin: 'sha256:pending',
          tombstonesBin: 'sha256:pending',
          shardMeta: 'sha256:pending',
        },
      })
    }

    manifest.updatedAt = Date.now()
    await this.writeStagedManifest(manifest)
    await this.writeActiveManifest(manifest)
    this.clearAllShardCaches()
  }

  async truncateModel(modelId: string): Promise<void> {
    const manifest = await this.loadManifest()
    if (!manifest) {
      return
    }
    if (this.normalizeModelId(manifest.activeModel) !== modelId) {
      return
    }
    await this.writeActiveManifest({
      ...manifest,
      updatedAt: Date.now(),
      shards: [],
    })
    this.clearAllShardCaches()
  }

  async clearVectorsByModelIds(modelIds: string[]): Promise<void> {
    if (modelIds.length === 0) {
      return
    }
    const manifest = await this.loadManifest()
    if (!manifest) {
      return
    }
    if (!modelIds.includes(this.normalizeModelId(manifest.activeModel))) {
      return
    }
    await this.writeActiveManifest({
      ...manifest,
      updatedAt: Date.now(),
      shards: [],
    })
    this.clearAllShardCaches()
  }

  async vacuum(mode: VectorVacuumMode = 'light'): Promise<void> {
    const manifest = await this.loadManifest()
    if (!manifest) {
      return
    }
    const vacuumed = await this.vacuumManifest(manifest, mode)
    await this.writeActiveManifest({
      ...vacuumed,
      updatedAt: Date.now(),
    })
    this.clearAllShardCaches()
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
    const startedAt = Date.now()
    const phaseTimings: SearchPhaseTimings = {
      manifestLoadMs: 0,
      shardPrefilterMs: 0,
      indexLoadMs: 0,
      candidateSelectionMs: 0,
      tombstoneLoadMs: 0,
      rowBlockLoadMs: 0,
      vectorBlockLoadMs: 0,
      rerankMs: 0,
      dedupeSortMs: 0,
    }
    let phaseStartedAt = Date.now()
    const manifest = await this.loadManifest()
    phaseTimings.manifestLoadMs += Date.now() - phaseStartedAt
    if (!manifest) {
      this.lastSearchPhaseTimings = phaseTimings
      return []
    }

    const readyShards = manifest.shards.filter(
      (shard) =>
        shard.state === 'ready' &&
        this.modelMatchesNamespace(manifest.activeModel, embeddingModel.id) &&
        shard.dimension === embeddingModel.dimension,
    )

    phaseStartedAt = Date.now()
    const candidateShards = await this.filterCandidateShards(
      readyShards,
      options.scope,
    )
    phaseTimings.shardPrefilterMs += Date.now() - phaseStartedAt
    let totalProbeClusters = 0

    const candidateGroups = await this.mapWithConcurrency(
      candidateShards,
      Math.max(1, this.options.maxConcurrentShardQueries ?? 4),
      async (shard) => {
        const shardRoot = `${this.getRootPath()}/${shard.relativePath}`
        let shardPhaseStartedAt = Date.now()
        const shardMeta = await this.readShardMeta(`${shardRoot}/shard.meta.json`)
        const indexData = await this.readIndexFile(
          `${shardRoot}/index.bin`,
          shard.dimension,
          shard.vectorCount,
        )
        phaseTimings.indexLoadMs += Date.now() - shardPhaseStartedAt
        const candidates: Array<
          Omit<SelectEmbedding, 'embedding'> & {
            similarity: number
          }
        > = []
        shardPhaseStartedAt = Date.now()
        const candidateRowIds = this.selectCandidateRowIds(
          queryVector,
          indexData,
          shard.dimension,
        )
        phaseTimings.candidateSelectionMs += Date.now() - shardPhaseStartedAt
        totalProbeClusters += this.resolveProbeClusterCount(
          indexData.postingOffsets.length - 1,
        )
        const rowIdsByBlock = this.groupCandidateRowIdsByBlock(
          candidateRowIds,
          shardMeta.vectorBlockSize,
        )
        shardPhaseStartedAt = Date.now()
        const tombstonedRowIds = await this.readTombstoneRowIds(
          `${shardRoot}/tombstones.bin`,
        )
        phaseTimings.tombstoneLoadMs += Date.now() - shardPhaseStartedAt
        const rerankStartedAt = Date.now()
        const blockResults = await Promise.all(
          Array.from(rowIdsByBlock.entries()).map(async ([blockId, rowIds]) => {
            const rowBlockStartedAt = Date.now()
            const chunkRows = await this.readSearchableChunkRows(
              `${shardRoot}/rows/${this.formatBlockId(blockId)}.jsonl`,
            )
            phaseTimings.rowBlockLoadMs += Date.now() - rowBlockStartedAt
            const vectorBlockStartedAt = Date.now()
            const vectorBytes = await this.readStoredVectorBytes(
              `${shardRoot}/vectors/${this.formatBlockId(blockId)}.f32`,
              shard.dimension,
            )
            phaseTimings.vectorBlockLoadMs += Date.now() - vectorBlockStartedAt
            const flatVectors = new Float32Array(vectorBytes)
            rowIds.forEach((rowId) => {
              const row = this.getSearchableRowForRowId(
                chunkRows,
                rowId,
                blockId,
                shardMeta.vectorBlockSize,
              )
              if (!row) {
                return
              }
              if (tombstonedRowIds.has(rowId)) {
                return
              }
              if (!this.matchesScope(row.file_path, options.scope)) {
                return
              }
              if (
                !this.hasVectorRow(
                  vectorBytes,
                  shard.dimension,
                  rowId,
                  blockId,
                  shardMeta.vectorBlockSize,
                )
              ) {
                return
              }
              const similarity = this.cosineSimilarityToRowView(
                queryVector,
                flatVectors,
                indexData.rowNorms,
                shard.dimension,
                rowId,
                blockId,
                shardMeta.vectorBlockSize,
              )
              if (similarity <= options.minSimilarity) {
                return
              }
              this.pushTopCandidate(candidates, options.limit, {
                id: row.row_id,
                path: row.file_path,
                mtime: row.file_mtime,
                content: row.text,
                content_hash: row.chunk_content_hash,
                model: embeddingModel.id,
                dimension: embeddingModel.dimension,
                metadata: row.metadata_json,
                similarity,
              })
            })
          }),
        )
        void blockResults
        phaseTimings.rerankMs += Date.now() - rerankStartedAt

        return candidates
      },
    )

    phaseStartedAt = Date.now()
    const candidates = candidateGroups
      .flat()
      .sort((a, b) => b.similarity - a.similarity)

    const deduplicated = this.deduplicateCandidatesByContentHash(candidates)
    const result = deduplicated.slice(
      0,
      options.limit,
    )
    phaseTimings.dedupeSortMs += Date.now() - phaseStartedAt
    this.lastSearchPhaseTimings = phaseTimings

    console.debug('[YOLO][ShardedVectorBackend] similarity search metrics', {
      searchedShards: candidateShards.length,
      probeClusters: totalProbeClusters,
      candidateCount: candidates.length,
      deduplicatedCandidateCount: deduplicated.length,
      returnedCount: result.length,
      phaseTimings,
      elapsedMs: Date.now() - startedAt,
    })

    return result
  }

  getLastSearchPhaseTimings(): SearchPhaseTimings | null {
    return this.lastSearchPhaseTimings
  }

  async getEmbeddingStats(): Promise<EmbeddingDbStats[]> {
    const manifest = await this.loadManifest()
    if (!manifest) {
      return []
    }

    const readyShards = manifest.shards.filter((shard) => shard.state === 'ready')

    const totalDataBytes = await Promise.all(
      readyShards
        .map(async (shard) => {
          const shardRoot = `${this.getRootPath()}/${shard.relativePath}`
          const shardMeta = await this.readShardMeta(`${shardRoot}/shard.meta.json`)
          const chunkBytes = await this.options.app.vault.adapter.readBinary(
            `${shardRoot}/chunks.sqlite`,
          )
          const vectorBlockSizes = await Promise.all(
            Array.from({ length: shardMeta.vectorBlockCount }, (_, blockId) =>
              this.options.app.vault.adapter
                .readBinary(
                  `${shardRoot}/vectors/${this.formatBlockId(blockId)}.f32`,
                )
                .then((buffer) => buffer.byteLength),
            ),
          )
          return (
            chunkBytes.byteLength +
            vectorBlockSizes.reduce((sum, size) => sum + size, 0)
          )
        }),
    )

    const shardRowCounts = await Promise.all(
      readyShards.map(async (shard) => {
        const tombstones = await this.readTombstoneRowIds(
          `${this.getRootPath()}/${shard.relativePath}/tombstones.bin`,
        )
        return Math.max(0, shard.vectorCount - tombstones.size)
      }),
    )

    return [
      {
        model: this.normalizeModelId(manifest.activeModel),
        rowCount: shardRowCounts.reduce((sum, count) => sum + count, 0),
        totalDataBytes: totalDataBytes.reduce((sum, size) => sum + size, 0),
      },
    ]
  }

  private async readStoredChunkRows(
    path: string,
  ): Promise<StoredChunkRow[]> {
    const cached = this.chunkRowsCache.get(path)
    if (cached) {
      return cached
    }
    const pending = this.readStoredChunkRowsUncached(path)
    this.chunkRowsCache.set(path, pending)
    try {
      return await pending
    } catch (error) {
      this.chunkRowsCache.delete(path)
      throw error
    }
  }

  private async readStoredChunkRowsUncached(
    path: string,
  ): Promise<StoredChunkRow[]> {
    const sqlJs = await getSqlJs()
    const buffer = await this.options.app.vault.adapter.readBinary(path)
    const db = new sqlJs.Database(new Uint8Array(buffer))
    const rows: StoredChunkRow[] = []
    const stmt = db.prepare(
      `SELECT row_id, chunk_id, file_path, file_mtime, file_content_hash, chunk_content_hash, start_offset, end_offset, start_line, end_line, page, text, metadata_json FROM chunks ORDER BY row_id`,
    )
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>
      rows.push({
        row_id: Number(row.row_id),
        chunk_id: String(row.chunk_id),
        file_path: String(row.file_path),
        file_mtime: Number(row.file_mtime),
        file_content_hash:
          row.file_content_hash == null ? null : String(row.file_content_hash),
        chunk_content_hash:
          row.chunk_content_hash == null
            ? null
            : String(row.chunk_content_hash),
        start_offset:
          row.start_offset == null ? null : Number(row.start_offset),
        end_offset: row.end_offset == null ? null : Number(row.end_offset),
        start_line: Number(row.start_line),
        end_line: Number(row.end_line),
        page: row.page == null ? null : Number(row.page),
        text: String(row.text),
        metadata_json: JSON.parse(String(row.metadata_json)) as VectorMetaData,
      })
    }
    stmt.free()
    db.close()
    return rows
  }

  private async loadRowsForModel(modelId: string): Promise<StoredChunkRow[]> {
    const rows = await this.loadRowsForModelWithShard(modelId)
    return rows.map((item) => item.row)
  }

  private async loadRowsForModelWithShard(
    modelId: string,
  ): Promise<ShardScopedRow[]> {
    const manifest = await this.loadManifest()
    if (!manifest) {
      return []
    }
    if (!this.modelMatchesNamespace(manifest.activeModel, modelId)) {
      return []
    }

    const allRows = await Promise.all(
      manifest.shards
        .filter((shard) => shard.state === 'ready')
        .map(async (shard) => {
          const shardRoot = `${this.getRootPath()}/${shard.relativePath}`
          const [rows, tombstones] = await Promise.all([
            this.readStoredChunkRows(`${shardRoot}/chunks.sqlite`),
            this.readTombstoneRowIds(`${shardRoot}/tombstones.bin`),
          ])
          return rows.map((row) => ({
            shardId: shard.id,
            shardRoot,
            shardDimension: shard.dimension,
            row,
          })).filter((item) => !tombstones.has(item.row.row_id))
        }),
    )

    return allRows.flat()
  }

  private encodeGlobalRowId(shardId: string, rowId: number): number {
    const shardNumericId = Number.parseInt(shardId, 10)
    if (!Number.isInteger(shardNumericId) || shardNumericId < 0) {
      throw new Error(`Invalid shard id for global row encoding: ${shardId}`)
    }
    if (!Number.isInteger(rowId) || rowId < 0 || rowId >= GLOBAL_ROW_ID_FACTOR) {
      throw new Error(`Row id ${rowId} exceeds global row encoding capacity`)
    }
    return shardNumericId * GLOBAL_ROW_ID_FACTOR + rowId
  }

  private decodeGlobalRowId(globalRowId: number): {
    shardId: string
    rowId: number
  } {
    if (!Number.isInteger(globalRowId) || globalRowId < 0) {
      throw new Error(`Invalid global row id: ${globalRowId}`)
    }
    const shardNumericId = Math.floor(globalRowId / GLOBAL_ROW_ID_FACTOR)
    const rowId = globalRowId % GLOBAL_ROW_ID_FACTOR
    return {
      shardId: `${shardNumericId}`.padStart(6, '0'),
      rowId,
    }
  }

  private groupGlobalRowIds(ids: number[]): Map<string, Set<number>> {
    const grouped = new Map<string, Set<number>>()
    for (const id of ids) {
      const decoded = this.decodeGlobalRowId(id)
      let rowIds = grouped.get(decoded.shardId)
      if (!rowIds) {
        rowIds = new Set<number>()
        grouped.set(decoded.shardId, rowIds)
      }
      rowIds.add(decoded.rowId)
    }
    return grouped
  }

  private async markTombstonesBySelection(
    selections: Map<string, Set<number>>,
  ): Promise<void> {
    if (selections.size === 0) {
      return
    }
    const manifest = await this.loadManifest()
    if (!manifest) {
      return
    }
    for (const shard of manifest.shards) {
      if (shard.state !== 'ready') {
        continue
      }
      const selection = selections.get(shard.id)
      if (!selection) {
        continue
      }
      const shardRoot = `${this.getRootPath()}/${shard.relativePath}`
      await this.appendTombstones(`${shardRoot}/tombstones.bin`, selection)
    }
    const vacuumed = await this.vacuumManifest(manifest, 'light')
    await this.writeActiveManifest({
      ...vacuumed,
      updatedAt: Date.now(),
    })
    this.clearAllShardCaches()
  }

  private async vacuumManifest(
    manifest: ShardedManifest,
    mode: VectorVacuumMode,
  ): Promise<ShardedManifest> {
    let retainedShards: ShardedManifest['shards'] = []
    for (const shard of manifest.shards) {
      if (shard.state !== 'ready') {
        retainedShards.push(shard)
        continue
      }
      const nextShard = await this.vacuumReadyShard(manifest, shard)
      if (nextShard) {
        retainedShards.push(nextShard)
      }
    }
    if (mode === 'full') {
      retainedShards = await this.mergeAdjacentSmallReadyShards({
        ...manifest,
        shards: retainedShards,
      })
    }
    return {
      ...manifest,
      shards: retainedShards,
    }
  }

  private async vacuumReadyShard(
    manifest: ShardedManifest,
    shard: ShardedManifest['shards'][number],
  ): Promise<ShardedManifest['shards'][number] | null> {
    const shardRoot = `${this.getRootPath()}/${shard.relativePath}`
    const tombstones = await this.readTombstoneRowIds(`${shardRoot}/tombstones.bin`)
    if (tombstones.size >= shard.vectorCount) {
      await this.removePathIfExists(shardRoot)
      return null
    }
    const deadRatio = tombstones.size / Math.max(1, shard.vectorCount)
    if (deadRatio < this.getCompactDeadRatio()) {
      return shard
    }
    const storedRows = await this.readStoredChunkRows(`${shardRoot}/chunks.sqlite`)
    const survivingRows = storedRows.filter((row) => !tombstones.has(row.row_id))
    const rebuiltRows = await this.rebuildTempRowsFromStoredRows({
      shardRoot,
      storedRows: survivingRows,
      dimension: shard.dimension,
    })
    await this.replaceReadyShard({
      manifest,
      shard,
      shardRoot,
      rebuiltRows,
    })
    return {
      ...shard,
      vectorCount: rebuiltRows.length,
    }
  }

  private async replaceReadyShard(input: {
    manifest: ShardedManifest
    shard: ShardedManifest['shards'][number]
    shardRoot: string
    rebuiltRows: TempShardRow[]
  }): Promise<void> {
    await this.removePathIfExists(input.shardRoot)
    await this.ensureDirChain(input.shardRoot)
    await this.writeTempShardArtifacts({
      modelNamespace: input.manifest.activeModel,
      runId: 'rewrite',
      shardId: input.shard.id,
      rows: input.rebuiltRows,
    })
    const tempRoot = this.getTempShardPath(
      input.manifest.activeModel,
      'rewrite',
      input.shard.id,
    )
    await this.copyShardArtifacts(tempRoot, input.shardRoot)
    await this.removePathIfExists(tempRoot)
  }

  private async mergeAdjacentSmallReadyShards(
    manifest: ShardedManifest,
  ): Promise<ShardedManifest['shards']> {
    const readyShards = [...manifest.shards].sort((left, right) =>
      left.id.localeCompare(right.id),
    )
    const merged: ShardedManifest['shards'] = []
    const maxVectorsPerShard = Math.max(1, this.options.maxVectorsPerShard ?? 1000)

    for (let index = 0; index < readyShards.length; index += 1) {
      const current = readyShards[index]
      if (current.state !== 'ready') {
        merged.push(current)
        continue
      }

      let combinedShard = current
      let combinedRows: TempShardRow[] | null = null
      let combinedRoot = `${this.getRootPath()}/${current.relativePath}`

      while (index + 1 < readyShards.length) {
        const next = readyShards[index + 1]
        if (
          next.state !== 'ready' ||
          combinedShard.dimension !== next.dimension
        ) {
          break
        }
        const nextRoot = `${this.getRootPath()}/${next.relativePath}`
        const [currentTombstones, nextTombstones] = await Promise.all([
          this.readTombstoneRowIds(`${combinedRoot}/tombstones.bin`),
          this.readTombstoneRowIds(`${nextRoot}/tombstones.bin`),
        ])
        if (currentTombstones.size > 0 || nextTombstones.size > 0) {
          break
        }
        const currentRowCount =
          combinedRows?.length ?? combinedShard.vectorCount
        if (currentRowCount + next.vectorCount > maxVectorsPerShard) {
          break
        }

        const currentTempRows: TempShardRow[] =
          combinedRows ??
          (await this.rebuildTempRowsFromStoredRows({
            shardRoot: combinedRoot,
            storedRows: await this.readStoredChunkRows(
              `${combinedRoot}/chunks.sqlite`,
            ),
            dimension: combinedShard.dimension,
          }))
        const nextTempRows: TempShardRow[] = await this.rebuildTempRowsFromStoredRows({
          shardRoot: nextRoot,
          storedRows: await this.readStoredChunkRows(`${nextRoot}/chunks.sqlite`),
          dimension: next.dimension,
        })
        combinedRows = [...currentTempRows, ...nextTempRows]
        await this.replaceReadyShard({
          manifest,
          shard: current,
          shardRoot: combinedRoot,
          rebuiltRows: combinedRows,
        })
        await this.removePathIfExists(nextRoot)
        combinedShard = {
          ...current,
          vectorCount: combinedRows.length,
        }
        index += 1
      }

      merged.push(combinedShard)
    }

    return merged
  }

  private createManifestForInsert(input: {
    existingManifest: ShardedManifest | null
    modelNamespace: string
  }): ShardedManifest {
    if (
      input.existingManifest &&
      input.existingManifest.activeModel === input.modelNamespace
    ) {
      return {
        ...input.existingManifest,
        shards: [...input.existingManifest.shards].sort((left, right) =>
          left.id.localeCompare(right.id),
        ),
      }
    }

    return {
      schemaVersion: 1,
      formatVersion: 1,
      activeModel: input.modelNamespace,
      updatedAt: Date.now(),
      shards: [],
    }
  }

  private buildTempRowsFromBatch(
    batch: Array<InsertEmbedding & { embedding: number[] }>,
  ): TempShardRow[] {
    return batch.map((row, rowIndex) => ({
      chunkId: `batch-${rowIndex}`,
      path: row.path,
      mtime: row.mtime,
      contentHash: row.content_hash ?? null,
      startLine: row.metadata.startLine,
      endLine: row.metadata.endLine,
      page: row.metadata.page,
      text: row.content,
      metadata: row.metadata,
      embedding: row.embedding,
    }))
  }

  private async buildTempRowsFromInsertedRows(input: {
    storedRows: StoredChunkRow[]
    insertedRows: Array<InsertEmbedding & { embedding: number[] }>
    dimension: number
    shardRoot: string
  }): Promise<TempShardRow[]> {
    const existingRows = await this.rebuildTempRowsFromStoredRows({
      shardRoot: input.shardRoot,
      storedRows: input.storedRows,
      dimension: input.dimension,
    })
    return [...existingRows, ...this.buildTempRowsFromBatch(input.insertedRows)]
  }

  private async rebuildTempRowsFromStoredRows(input: {
    shardRoot: string
    storedRows: StoredChunkRow[]
    dimension: number
  }): Promise<TempShardRow[]> {
    const rowsByBlock = new Map<number, StoredChunkRow[]>()
    const vectorBlockSize = this.getVectorBlockSize()
    input.storedRows.forEach((row) => {
      const blockId = Math.floor(row.row_id / vectorBlockSize)
      const bucket = rowsByBlock.get(blockId)
      if (bucket) {
        bucket.push(row)
      } else {
        rowsByBlock.set(blockId, [row])
      }
    })

    const tempRows: TempShardRow[] = []
    for (const [blockId, blockRows] of rowsByBlock.entries()) {
      const vectorBytes = await this.readStoredVectorBytes(
        `${input.shardRoot}/vectors/${this.formatBlockId(blockId)}.f32`,
        input.dimension,
      )
      const flatVectors = new Float32Array(vectorBytes)
      blockRows
        .sort((left, right) => left.row_id - right.row_id)
        .forEach((row) => {
          const localRowId = row.row_id - blockId * vectorBlockSize
          const start = localRowId * input.dimension
          const embedding = Array.from(
            flatVectors.slice(start, start + input.dimension),
          )
          tempRows.push({
            chunkId: row.chunk_id,
            path: row.file_path,
            mtime: row.file_mtime,
            contentHash: row.chunk_content_hash,
            startOffset: row.start_offset ?? undefined,
            endOffset: row.end_offset ?? undefined,
            startLine: row.start_line,
            endLine: row.end_line,
            page: row.page ?? undefined,
            text: row.text,
            metadata: row.metadata_json,
            embedding,
          })
        })
    }

    return tempRows
  }

  private async readSearchableChunkRows(
    path: string,
  ): Promise<SearchableChunkRow[]> {
    const cached = this.searchRowsCache.get(path)
    if (cached) {
      return cached
    }
    const pending = this.readSearchableChunkRowsUncached(path)
    this.searchRowsCache.set(path, pending)
    try {
      return await pending
    } catch (error) {
      this.searchRowsCache.delete(path)
      throw error
    }
  }

  private async readSearchableChunkRowsUncached(
    path: string,
  ): Promise<SearchableChunkRow[]> {
    const raw = await this.options.app.vault.adapter.read(path)
    if (!raw.trim()) {
      return []
    }
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map(
        (line) =>
          JSON.parse(line) as {
            row_id: number
            file_path: string
            file_mtime: number
            chunk_content_hash: string | null
            text: string
            metadata_json: VectorMetaData
          },
      )
  }

  private async ensureDirChain(fullPath: string): Promise<void> {
    const segments = normalizePath(fullPath).split('/')
    let current = ''
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment
      if (!(await this.options.app.vault.adapter.exists(current))) {
        await this.options.app.vault.adapter.mkdir(current)
      }
    }
  }

  private partitionRows<T>(rows: T[]): T[][] {
    const maxVectorsPerShard = Math.max(1, this.options.maxVectorsPerShard ?? 1000)
    const batches: T[][] = []
    for (let index = 0; index < rows.length; index += maxVectorsPerShard) {
      batches.push(rows.slice(index, index + maxVectorsPerShard))
    }
    return batches
  }

  private buildShardMeta(input: {
    shardId: string
    modelNamespace: string
    dimension: number
    rows: TempShardRow[]
    vectorBlockSize: number
    vectorBlockCount: number
  }): ShardMeta {
    const filePaths = Array.from(new Set(input.rows.map((row) => row.path))).sort()
    const pathPrefixes = Array.from(
      new Set(
        filePaths.flatMap((path) => {
          const slashIndex = path.lastIndexOf('/')
          return slashIndex === -1 ? [] : [path.slice(0, slashIndex)]
        }),
      ),
    ).sort()

    return {
      shardId: input.shardId,
      modelNamespace: input.modelNamespace,
      dimension: input.dimension,
      vectorCount: input.rows.length,
      vectorBlockSize: input.vectorBlockSize,
      vectorBlockCount: input.vectorBlockCount,
      filePaths,
      pathPrefixes,
    }
  }

  private async readShardMeta(path: string): Promise<ShardMeta> {
    const cached = this.shardMetaCache.get(path)
    if (cached) {
      return cached
    }
    const pending = this.readShardMetaUncached(path)
    this.shardMetaCache.set(path, pending)
    try {
      return await pending
    } catch (error) {
      this.shardMetaCache.delete(path)
      throw error
    }
  }

  private async readShardMetaUncached(path: string): Promise<ShardMeta> {
    const raw = await this.options.app.vault.adapter.read(path)
    return JSON.parse(raw) as ShardMeta
  }

  private async filterCandidateShards(
    shards: ShardedManifest['shards'],
    scope: SimilaritySearchOptions['scope'],
  ): Promise<ShardedManifest['shards']> {
    if (!scope || (scope.files.length === 0 && scope.folders.length === 0)) {
      return shards
    }

    const scopeFiles = new Set(scope.files)
    const scopeFolders = scope.folders

    const decisions = await Promise.all(
      shards.map(async (shard) => {
        const shardRoot = `${this.getRootPath()}/${shard.relativePath}`
        const meta = await this.readShardMeta(`${shardRoot}/shard.meta.json`)
        const matchesFile =
          scopeFiles.size === 0 ||
          meta.filePaths.some((path) => scopeFiles.has(path))
        const matchesFolder =
          scopeFolders.length === 0 ||
          meta.filePaths.some((path) =>
            scopeFolders.some((folder) => path.startsWith(`${folder}/`)),
          ) ||
          meta.pathPrefixes.some((prefix) =>
            scopeFolders.some(
              (folder) =>
                prefix === folder ||
                prefix.startsWith(`${folder}/`) ||
                folder.startsWith(`${prefix}/`),
            ),
          )

        return { shard, include: matchesFile && matchesFolder }
      }),
    )

    return decisions.filter((item) => item.include).map((item) => item.shard)
  }

  private async mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    iteratee: (item: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    const results = new Array<R>(items.length)
    let nextIndex = 0

    const worker = async () => {
      while (true) {
        const currentIndex = nextIndex
        nextIndex += 1
        if (currentIndex >= items.length) {
          return
        }
        results[currentIndex] = await iteratee(items[currentIndex], currentIndex)
      }
    }

    const workerCount = Math.min(Math.max(1, concurrency), items.length)
    await Promise.all(
      Array.from({ length: workerCount }, () => worker()),
    )
    return results
  }

  private async copyShardArtifacts(
    sourceRoot: string,
    targetRoot: string,
  ): Promise<void> {
    const shardMeta = await this.options.app.vault.adapter.read(
      `${sourceRoot}/shard.meta.json`,
    )
    const parsedShardMeta = JSON.parse(shardMeta) as ShardMeta
    const [chunksSqlite, indexBin, tombstonesBin] =
      await Promise.all([
      this.options.app.vault.adapter.readBinary(`${sourceRoot}/chunks.sqlite`),
      this.options.app.vault.adapter.readBinary(`${sourceRoot}/index.bin`),
      this.options.app.vault.adapter.readBinary(`${sourceRoot}/tombstones.bin`),
      ])
    const vectorBlocks = await Promise.all(
      Array.from(
        { length: parsedShardMeta.vectorBlockCount },
        async (_, blockId) =>
          this.options.app.vault.adapter.readBinary(
            `${sourceRoot}/vectors/${this.formatBlockId(blockId)}.f32`,
          ),
      ),
    )
    const rowBlocks = await Promise.all(
      Array.from(
        { length: parsedShardMeta.vectorBlockCount },
        async (_, blockId) =>
          this.options.app.vault.adapter.read(
            `${sourceRoot}/rows/${this.formatBlockId(blockId)}.jsonl`,
          ),
      ),
    )
    await Promise.all([
      this.options.app.vault.adapter.writeBinary(
        `${targetRoot}/chunks.sqlite`,
        chunksSqlite,
      ),
      this.options.app.vault.adapter.writeBinary(
        `${targetRoot}/index.bin`,
        indexBin,
      ),
      this.options.app.vault.adapter.writeBinary(
        `${targetRoot}/tombstones.bin`,
        tombstonesBin,
      ),
      this.options.app.vault.adapter.write(
        `${targetRoot}/shard.meta.json`,
        shardMeta,
      ),
      ...vectorBlocks.map((block, blockId) =>
        this.options.app.vault.adapter.writeBinary(
          `${targetRoot}/vectors/${this.formatBlockId(blockId)}.f32`,
          block,
        ),
      ),
      ...rowBlocks.map((block, blockId) =>
        this.options.app.vault.adapter.write(
          `${targetRoot}/rows/${this.formatBlockId(blockId)}.jsonl`,
          block,
        ),
      ),
    ])
  }

  private async removePathIfExists(path: string): Promise<void> {
    if (!(await this.options.app.vault.adapter.exists(path))) {
      return
    }

    const adapter = this.options.app.vault.adapter as unknown as {
      rmdir?: (target: string, recursive: boolean) => Promise<void>
      remove?: (target: string) => Promise<void>
    }

    if (typeof adapter.rmdir === 'function') {
      await adapter.rmdir(path, true)
      return
    }
    if (typeof adapter.remove === 'function') {
      await adapter.remove(path)
    }
  }

  private normalizeModelId(modelNamespace: string): string {
    const atIndex = modelNamespace.lastIndexOf('@')
    if (atIndex === -1) {
      return modelNamespace
    }
    return modelNamespace.slice(0, atIndex)
  }

  private modelMatchesNamespace(
    modelNamespace: string,
    requestedModelId: string,
  ): boolean {
    return (
      modelNamespace === requestedModelId ||
      this.normalizeModelId(modelNamespace) === requestedModelId
    )
  }

  private async readStoredVectorBytes(
    path: string,
    dimension: number,
  ): Promise<ArrayBuffer> {
    const cacheKey = `${path}::${dimension}`
    const cached = this.vectorBytesCache.get(cacheKey)
    if (cached) {
      return cached
    }
    const pending = this.readStoredVectorBytesUncached(path, dimension)
    this.vectorBytesCache.set(cacheKey, pending)
    try {
      return await pending
    } catch (error) {
      this.vectorBytesCache.delete(cacheKey)
      throw error
    }
  }

  private getVectorBlockSize(): number {
    return Math.max(1, this.options.vectorBlockSize ?? 256)
  }

  private getCompactDeadRatio(): number {
    const ratio = this.options.compactDeadRatio ?? 0.8
    return Math.min(1, Math.max(0, ratio))
  }

  private formatBlockId(blockId: number): string {
    return `${blockId}`.padStart(6, '0')
  }

  private groupCandidateRowIdsByBlock(
    rowIds: number[],
    vectorBlockSize: number,
  ): Map<number, number[]> {
    const grouped = new Map<number, number[]>()
    rowIds.forEach((rowId) => {
      const blockId = Math.floor(rowId / vectorBlockSize)
      const existing = grouped.get(blockId)
      if (existing) {
        existing.push(rowId)
      } else {
        grouped.set(blockId, [rowId])
      }
    })
    return grouped
  }

  private async readStoredVectorBytesUncached(
    path: string,
    dimension: number,
  ): Promise<ArrayBuffer> {
    const buffer = await this.options.app.vault.adapter.readBinary(path)
    if (dimension <= 0) {
      throw new Error('Invalid vector dimension for sharded vector file')
    }
    if (buffer.byteLength % (dimension * Float32Array.BYTES_PER_ELEMENT) !== 0) {
      throw new Error('Sharded vector file size does not align with dimension')
    }
    return buffer
  }


  private buildIndexBytes(input: {
    dimension: number
    vectorCount: number
    rows?: TempShardRow[]
  }): ArrayBuffer {
    const rowNorms = new Float32Array(input.vectorCount)
    input.rows?.forEach((row, index) => {
      rowNorms[index] = this.computeVectorNorm(row.embedding)
    })

    const coarseIndex = this.buildCoarseIndex(
      input.rows ?? [],
      input.dimension,
    )

    const bytes = new Uint8Array(
      INDEX_HEADER_BYTES +
        rowNorms.byteLength +
        Uint32Array.BYTES_PER_ELEMENT +
        coarseIndex.centroids.byteLength +
        coarseIndex.postingOffsets.byteLength +
        coarseIndex.postingRowIds.byteLength,
    )
    this.writeAscii(bytes, 0, INDEX_MAGIC)
    bytes[7] = INDEX_VERSION
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    view.setUint32(8, input.dimension, true)
    view.setUint32(12, input.vectorCount, true)
    bytes.set(new Uint8Array(rowNorms.buffer), INDEX_HEADER_BYTES)
    let offset = INDEX_HEADER_BYTES + rowNorms.byteLength
    view.setUint32(offset, coarseIndex.clusterCount, true)
    offset += Uint32Array.BYTES_PER_ELEMENT
    bytes.set(new Uint8Array(coarseIndex.centroids.buffer), offset)
    offset += coarseIndex.centroids.byteLength
    bytes.set(new Uint8Array(coarseIndex.postingOffsets.buffer), offset)
    offset += coarseIndex.postingOffsets.byteLength
    bytes.set(new Uint8Array(coarseIndex.postingRowIds.buffer), offset)
    return bytes.buffer
  }

  private buildTombstonesBytes(rowIds: number[]): ArrayBuffer {
    const bytes = new Uint8Array(
      TOMBSTONE_HEADER_BYTES + rowIds.length * Uint32Array.BYTES_PER_ELEMENT,
    )
    this.writeAscii(bytes, 0, TOMBSTONE_MAGIC)
    bytes[7] = TOMBSTONE_VERSION
    const view = new DataView(bytes.buffer)
    view.setUint32(8, rowIds.length, true)
    rowIds.forEach((rowId, index) => {
      view.setUint32(
        TOMBSTONE_HEADER_BYTES + index * Uint32Array.BYTES_PER_ELEMENT,
        rowId,
        true,
      )
    })
    return bytes.buffer
  }

  private async readTombstoneRowIds(path: string): Promise<Set<number>> {
    const cached = this.tombstoneCache.get(path)
    if (cached) {
      return cached
    }
    const pending = this.readTombstoneRowIdsUncached(path)
    this.tombstoneCache.set(path, pending)
    try {
      return await pending
    } catch (error) {
      this.tombstoneCache.delete(path)
      throw error
    }
  }

  private async readTombstoneRowIdsUncached(path: string): Promise<Set<number>> {
    const bytes = new Uint8Array(
      await this.options.app.vault.adapter.readBinary(path),
    )
    if (bytes.byteLength < TOMBSTONE_HEADER_BYTES) {
      throw new Error('Invalid sharded tombstone header: file too small')
    }
    const magic = String.fromCharCode(...bytes.slice(0, 7))
    if (magic !== TOMBSTONE_MAGIC || bytes[7] !== TOMBSTONE_VERSION) {
      throw new Error('Invalid sharded tombstone header')
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const count = view.getUint32(8, true)
    const expectedBytes =
      TOMBSTONE_HEADER_BYTES + count * Uint32Array.BYTES_PER_ELEMENT
    if (bytes.byteLength !== expectedBytes) {
      throw new Error('Invalid sharded tombstone payload')
    }
    const rowIds = new Set<number>()
    for (let index = 0; index < count; index += 1) {
      rowIds.add(
        view.getUint32(
          TOMBSTONE_HEADER_BYTES + index * Uint32Array.BYTES_PER_ELEMENT,
          true,
        ),
      )
    }
    return rowIds
  }

  private async appendTombstones(
    path: string,
    rowIds: Set<number>,
  ): Promise<void> {
    const existing = await this.readTombstoneRowIds(path)
    const merged = new Set<number>(existing)
    rowIds.forEach((rowId) => merged.add(rowId))
    await this.options.app.vault.adapter.writeBinary(
      path,
      this.buildTombstonesBytes(Array.from(merged).sort((a, b) => a - b)),
    )
    this.tombstoneCache.set(path, Promise.resolve(merged))
  }

  private writeAscii(buffer: Uint8Array, offset: number, text: string): void {
    for (let index = 0; index < text.length; index += 1) {
      buffer[offset + index] = text.charCodeAt(index)
    }
  }

  private async readIndexFile(
    path: string,
    dimension: number,
    vectorCount: number,
  ): Promise<StoredIndexData> {
    const cacheKey = `${path}::${dimension}::${vectorCount}`
    const cached = this.indexCache.get(cacheKey)
    if (cached) {
      return cached
    }
    const pending = this.readIndexFileUncached(path, dimension, vectorCount)
    this.indexCache.set(cacheKey, pending)
    try {
      return await pending
    } catch (error) {
      this.indexCache.delete(cacheKey)
      throw error
    }
  }

  private async readIndexFileUncached(
    path: string,
    dimension: number,
    vectorCount: number,
  ): Promise<StoredIndexData> {
    const bytes = new Uint8Array(
      await this.options.app.vault.adapter.readBinary(path),
    )
    if (bytes.byteLength < INDEX_HEADER_BYTES) {
      throw new Error('Invalid sharded index header: file too small')
    }
    const magic = String.fromCharCode(...bytes.slice(0, 7))
    if (magic !== INDEX_MAGIC || bytes[7] !== INDEX_VERSION) {
      throw new Error('Invalid sharded index header')
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const storedDimension = view.getUint32(8, true)
    const storedVectorCount = view.getUint32(12, true)
    if (storedDimension !== dimension || storedVectorCount !== vectorCount) {
      throw new Error('Sharded index metadata does not match manifest shard')
    }

    const rowNormsStart = INDEX_HEADER_BYTES
    const rowNormsEnd =
      rowNormsStart + vectorCount * Float32Array.BYTES_PER_ELEMENT
    if (bytes.byteLength < rowNormsEnd + Uint32Array.BYTES_PER_ELEMENT) {
      throw new Error('Sharded index row norms do not match manifest shard')
    }

    const clusterCount = view.getUint32(rowNormsEnd, true)
    const centroidsStart = rowNormsEnd + Uint32Array.BYTES_PER_ELEMENT
    const centroidsBytes = clusterCount * dimension * Float32Array.BYTES_PER_ELEMENT
    const centroidsEnd = centroidsStart + centroidsBytes
    const postingOffsetsBytes =
      (clusterCount + 1) * Uint32Array.BYTES_PER_ELEMENT
    const postingOffsetsEnd = centroidsEnd + postingOffsetsBytes
    const postingRowIdsBytes = vectorCount * Uint32Array.BYTES_PER_ELEMENT
    const postingRowIdsEnd = postingOffsetsEnd + postingRowIdsBytes
    if (bytes.byteLength !== postingRowIdsEnd) {
      throw new Error('Sharded index cluster payload does not match manifest shard')
    }

    return {
      rowNorms: new Float32Array(
        bytes.buffer.slice(
          bytes.byteOffset + rowNormsStart,
          bytes.byteOffset + rowNormsEnd,
        ),
      ),
      clusterCentroids: new Float32Array(
        bytes.buffer.slice(
          bytes.byteOffset + centroidsStart,
          bytes.byteOffset + centroidsEnd,
        ),
      ),
      postingOffsets: new Uint32Array(
        bytes.buffer.slice(
          bytes.byteOffset + centroidsEnd,
          bytes.byteOffset + postingOffsetsEnd,
        ),
      ),
      postingRowIds: new Uint32Array(
        bytes.buffer.slice(
          bytes.byteOffset + postingOffsetsEnd,
          bytes.byteOffset + postingRowIdsEnd,
        ),
      ),
    }
  }

  private clearAllShardCaches(): void {
    this.manifestCache = null
    this.shardMetaCache.clear()
    this.indexCache.clear()
    this.chunkRowsCache.clear()
    this.searchRowsCache.clear()
    this.vectorBytesCache.clear()
    this.tombstoneCache.clear()
  }

  private matchesScope(
    path: string,
    scope: SimilaritySearchOptions['scope'],
  ): boolean {
    if (!scope) {
      return true
    }
    const matchesFile =
      scope.files.length === 0 || scope.files.includes(path)
    const matchesFolder =
      scope.folders.length === 0 ||
      scope.folders.some((folder) => path.startsWith(`${folder}/`))
    return matchesFile && matchesFolder
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0
    let normA = 0
    let normB = 0
    const length = Math.min(a.length, b.length)
    for (let index = 0; index < length; index += 1) {
      const left = a[index] ?? 0
      const right = b[index] ?? 0
      dot += left * right
      normA += left * left
      normB += right * right
    }
    if (normA === 0 || normB === 0) {
      return 0
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB))
  }

  private cosineSimilarityToRow(
    query: number[],
    vectorBytes: ArrayBuffer,
    rowNorms: Float32Array,
    dimension: number,
    rowId: number,
    blockId = 0,
    vectorBlockSize = rowNorms.length,
  ): number {
    const flatVectors = new Float32Array(vectorBytes)
    const localRowId = rowId - blockId * vectorBlockSize
    const start = localRowId * dimension
    if (start < 0 || start + dimension > flatVectors.length) {
      return 0
    }

    let dot = 0
    let normA = 0
    for (let index = 0; index < dimension; index += 1) {
      const left = query[index] ?? 0
      const right = flatVectors[start + index] ?? 0
      dot += left * right
      normA += left * left
    }

    const normB = rowNorms[rowId] ?? 0
    if (normA === 0 || normB === 0) {
      return 0
    }
    return dot / (Math.sqrt(normA) * normB)
  }

  private cosineSimilarityToRowView(
    query: number[],
    flatVectors: Float32Array,
    rowNorms: Float32Array,
    dimension: number,
    rowId: number,
    blockId = 0,
    vectorBlockSize = rowNorms.length,
  ): number {
    const localRowId = rowId - blockId * vectorBlockSize
    const start = localRowId * dimension
    if (start < 0 || start + dimension > flatVectors.length) {
      return 0
    }

    let dot = 0
    let normA = 0
    for (let index = 0; index < dimension; index += 1) {
      const left = query[index] ?? 0
      const right = flatVectors[start + index] ?? 0
      dot += left * right
      normA += left * left
    }

    const normB = rowNorms[rowId] ?? 0
    if (normA === 0 || normB === 0) {
      return 0
    }
    return dot / (Math.sqrt(normA) * normB)
  }


  private hasVectorRow(
    vectorBytes: ArrayBuffer,
    dimension: number,
    rowId: number,
    blockId = 0,
    vectorBlockSize = Number.MAX_SAFE_INTEGER,
  ): boolean {
    const flatVectors = new Float32Array(vectorBytes)
    const localRowId = rowId - blockId * vectorBlockSize
    const start = localRowId * dimension
    return start >= 0 && start + dimension <= flatVectors.length
  }

  private getSearchableRowForRowId(
    rows: SearchableChunkRow[],
    rowId: number,
    blockId: number,
    vectorBlockSize: number,
  ): SearchableChunkRow | null {
    const localRowId = rowId - blockId * vectorBlockSize
    if (localRowId < 0 || localRowId >= rows.length) {
      return null
    }
    const row = rows[localRowId] ?? null
    if (!row || row.row_id !== rowId) {
      return null
    }
    return row
  }

  private async writeVectorBlocks(input: {
    shardPath: string
    rows: TempShardRow[]
    chunkRows: StoredChunkRow[]
    dimension: number
    vectorBlockSize: number
  }): Promise<void> {
    await this.ensureDirChain(`${input.shardPath}/vectors`)
    await this.ensureDirChain(`${input.shardPath}/rows`)
    const blockCount = Math.ceil(input.rows.length / input.vectorBlockSize)
    await Promise.all(
      Array.from({ length: blockCount }, async (_, blockId) => {
        const start = blockId * input.vectorBlockSize
        const end = Math.min(start + input.vectorBlockSize, input.rows.length)
        const blockRows = input.rows.slice(start, end)
        const blockChunkRows = input.chunkRows.slice(start, end)
        const flat = new Float32Array(blockRows.length * input.dimension)
        blockRows.forEach((row, rowIndex) => {
          row.embedding.forEach((value, columnIndex) => {
            flat[rowIndex * input.dimension + columnIndex] = value
          })
        })
        await this.options.app.vault.adapter.writeBinary(
          `${input.shardPath}/vectors/${this.formatBlockId(blockId)}.f32`,
          flat.buffer,
        )
        await this.options.app.vault.adapter.write(
          `${input.shardPath}/rows/${this.formatBlockId(blockId)}.jsonl`,
          blockChunkRows
            .map((row) =>
              JSON.stringify({
                row_id: row.row_id,
                file_path: row.file_path,
                file_mtime: row.file_mtime,
                chunk_content_hash: row.chunk_content_hash,
                text: row.text,
                metadata_json: row.metadata_json,
              }),
            )
            .join('\n'),
        )
      }),
    )
  }

  private pushTopCandidate<T extends { similarity: number }>(
    candidates: T[],
    limit: number,
    candidate: T,
  ): void {
    candidates.push(candidate)
    candidates.sort((left, right) => right.similarity - left.similarity)
    if (candidates.length > limit) {
      candidates.length = limit
    }
  }

  private computeVectorNorm(vector: number[]): number {
    let sum = 0
    for (let index = 0; index < vector.length; index += 1) {
      const value = vector[index] ?? 0
      sum += value * value
    }
    return Math.sqrt(sum)
  }

  private buildCoarseIndex(
    rows: TempShardRow[],
    dimension: number,
  ): {
    clusterCount: number
    centroids: Float32Array
    postingOffsets: Uint32Array
    postingRowIds: Uint32Array
  } {
    const vectorCount = rows.length
    const clusterCount = Math.max(
      1,
      Math.min(
        vectorCount,
        this.options.targetCentroidsPerShard ??
          Math.max(1, Math.round(Math.sqrt(vectorCount))),
      ),
    )

    const { assignments, centroids } = this.runKmeans(
      rows.map((row) => row.embedding),
      dimension,
      clusterCount,
    )

    const postingOffsets = new Uint32Array(clusterCount + 1)
    const orderedRowIds: number[] = []
    for (let clusterId = 0; clusterId < clusterCount; clusterId += 1) {
      postingOffsets[clusterId] = orderedRowIds.length
      assignments.forEach((assignedClusterId, rowId) => {
        if (assignedClusterId === clusterId) {
          orderedRowIds.push(rowId)
        }
      })
    }
      postingOffsets[clusterCount] = orderedRowIds.length

    return {
      clusterCount,
      centroids,
      postingOffsets,
      postingRowIds: Uint32Array.from(orderedRowIds),
    }
  }

  private runKmeans(
    vectors: number[][],
    dimension: number,
    clusterCount: number,
  ): {
    assignments: number[]
    centroids: Float32Array
  } {
    const centroids = new Float32Array(clusterCount * dimension)
    const seedIndices = this.chooseKmeansSeeds(vectors, clusterCount)
    seedIndices.forEach((vectorIndex, clusterId) => {
      const vector = vectors[vectorIndex] ?? []
      for (let dim = 0; dim < dimension; dim += 1) {
        centroids[clusterId * dimension + dim] = vector[dim] ?? 0
      }
    })

    const assignments = new Array<number>(vectors.length).fill(0)
    const iterations = Math.min(6, Math.max(2, vectors.length))

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      let changed = false
      vectors.forEach((vector, vectorIndex) => {
        const nextClusterId = this.findNearestCentroid(
          vector,
          centroids,
          dimension,
          clusterCount,
        )
        if (assignments[vectorIndex] !== nextClusterId) {
          assignments[vectorIndex] = nextClusterId
          changed = true
        }
      })

      const nextCentroids = new Float32Array(clusterCount * dimension)
      const clusterSizes = new Uint32Array(clusterCount)
      vectors.forEach((vector, vectorIndex) => {
        const clusterId = assignments[vectorIndex]
        clusterSizes[clusterId] += 1
        for (let dim = 0; dim < dimension; dim += 1) {
          nextCentroids[clusterId * dimension + dim] += vector[dim] ?? 0
        }
      })

      for (let clusterId = 0; clusterId < clusterCount; clusterId += 1) {
        if (clusterSizes[clusterId] === 0) {
          const seedVector = vectors[seedIndices[clusterId] ?? 0] ?? []
          for (let dim = 0; dim < dimension; dim += 1) {
            nextCentroids[clusterId * dimension + dim] = seedVector[dim] ?? 0
          }
          continue
        }
        for (let dim = 0; dim < dimension; dim += 1) {
          nextCentroids[clusterId * dimension + dim] /=
            clusterSizes[clusterId]
        }
      }

      centroids.set(nextCentroids)
      if (!changed) {
        break
      }
    }

    return { assignments, centroids }
  }

  private chooseKmeansSeeds(vectors: number[][], clusterCount: number): number[] {
    const seeds = [0]
    while (seeds.length < clusterCount) {
      let bestIndex = 0
      let bestDistance = Number.NEGATIVE_INFINITY
      vectors.forEach((vector, vectorIndex) => {
        if (seeds.includes(vectorIndex)) {
          return
        }
        const nearestSeedDistance = Math.min(
          ...seeds.map((seedIndex) =>
            1 - this.cosineSimilarity(vector, vectors[seedIndex] ?? []),
          ),
        )
        if (nearestSeedDistance > bestDistance) {
          bestDistance = nearestSeedDistance
          bestIndex = vectorIndex
        }
      })
      seeds.push(bestIndex)
    }
    return seeds
  }

  private findNearestCentroid(
    vector: number[],
    centroids: Float32Array,
    dimension: number,
    clusterCount: number,
  ): number {
    let bestClusterId = 0
    let bestSimilarity = Number.NEGATIVE_INFINITY
    for (let clusterId = 0; clusterId < clusterCount; clusterId += 1) {
      let dot = 0
      let normA = 0
      let normB = 0
      const centroidOffset = clusterId * dimension
      for (let dim = 0; dim < dimension; dim += 1) {
        const left = vector[dim] ?? 0
        const right = centroids[centroidOffset + dim] ?? 0
        dot += left * right
        normA += left * left
        normB += right * right
      }
      const similarity =
        normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB))
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity
        bestClusterId = clusterId
      }
    }
    return bestClusterId
  }

  private selectCandidateRowIds(
    queryVector: number[],
    indexData: StoredIndexData,
    dimension: number,
  ): number[] {
    const clusterCount = indexData.postingOffsets.length - 1
    if (clusterCount <= 1) {
      return Array.from(indexData.postingRowIds)
    }

    const scoredClusters: Array<{ clusterId: number; similarity: number }> = []
    for (let clusterId = 0; clusterId < clusterCount; clusterId += 1) {
      scoredClusters.push({
        clusterId,
        similarity: this.cosineSimilarityToCentroid(
          queryVector,
          indexData.clusterCentroids,
          dimension,
          clusterId,
        ),
      })
    }

    const clustersToProbe = scoredClusters
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, this.resolveProbeClusterCount(clusterCount))

    const rowIds: number[] = []
    clustersToProbe.forEach(({ clusterId }) => {
      const start = indexData.postingOffsets[clusterId] ?? 0
      const end = indexData.postingOffsets[clusterId + 1] ?? start
      for (let offset = start; offset < end; offset += 1) {
        rowIds.push(indexData.postingRowIds[offset] ?? 0)
      }
    })
    return rowIds
  }

  private cosineSimilarityToCentroid(
    query: number[],
    centroids: Float32Array,
    dimension: number,
    clusterId: number,
  ): number {
    const start = clusterId * dimension
    let dot = 0
    let normA = 0
    let normB = 0
    for (let index = 0; index < dimension; index += 1) {
      const left = query[index] ?? 0
      const right = centroids[start + index] ?? 0
      dot += left * right
      normA += left * left
      normB += right * right
    }
    if (normA === 0 || normB === 0) {
      return 0
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB))
  }

  private resolveProbeClusterCount(clusterCount: number): number {
    const baseProbeCount = Math.max(1, this.options.maxProbeClusters ?? 1)
    const adaptiveScale = Math.max(1, this.options.adaptiveProbeScale ?? 1)
    const adaptiveProbeCount = Math.ceil(
      (clusterCount * adaptiveScale) / (adaptiveScale + 1),
    )
    return Math.min(clusterCount, Math.max(baseProbeCount, adaptiveProbeCount))
  }

  private deduplicateCandidatesByContentHash<T extends {
    content_hash: string | null
    similarity: number
  }>(candidates: T[]): T[] {
    const seenHashes = new Set<string>()
    const deduplicated: T[] = []
    for (const candidate of candidates) {
      if (!candidate.content_hash) {
        deduplicated.push(candidate)
        continue
      }
      if (seenHashes.has(candidate.content_hash)) {
        continue
      }
      seenHashes.add(candidate.content_hash)
      deduplicated.push(candidate)
    }
    return deduplicated
  }
}
