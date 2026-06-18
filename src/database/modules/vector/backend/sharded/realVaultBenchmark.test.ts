import * as fs from 'fs/promises'
import * as path from 'path'
import { pathToFileURL } from 'url'

import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite/vector'
import { and, asc, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'

import { getEmbeddingModelClient } from '../../../../../core/rag/embedding'
import { embeddingTable, InsertEmbedding } from '../../../../schema'
import { PgliteVectorBackend } from '../PgliteVectorBackend'
import {
  analyzeShardedBenchmark,
  type RealVaultBenchmarkAggregate,
} from './realVaultBenchmark.analysis'
import {
  buildFallbackQueriesFromRows,
  buildHarderStoredVectorQueries,
  computeExactTopK,
  computeQueryComparisons,
  type BenchmarkQuery,
  type SearchHit,
} from './realVaultBenchmark.helpers'
import {
  aggregateMetrics,
  classifyBenchmarkQuery,
  groupMetricsByQueryKind,
} from './realVaultBenchmark.reporting'
import {
  ShardedVectorBackend,
  type SearchPhaseTimings,
} from './ShardedVectorBackend'

const runRealBenchmark =
  process.env.YOLO_RUN_REAL_VAULT_BENCHMARK === '1' ? describe : describe.skip

const REAL_VAULT_ROOT =
  process.env.YOLO_REAL_VAULT_ROOT ?? 'D:/Obsidian/个人笔记'
const REAL_SETTINGS_PATH = path.join(
  REAL_VAULT_ROOT,
  '.obsidian/plugins/yolo/data.json',
)
const REAL_PGLITE_SNAPSHOT_PATH = path.join(
  REAL_VAULT_ROOT,
  'YOLO/.yolo_vector_db.tar.gz',
)
const BENCHMARK_BASE_DIR =
  process.env.YOLO_BENCHMARK_BASE_DIR ?? 'YOLO/benchmark-sharded'
const BENCHMARK_MAX_ROWS = Number(process.env.YOLO_BENCHMARK_MAX_ROWS ?? '5000')
const BENCHMARK_QUERY_COUNT = Number(
  process.env.YOLO_BENCHMARK_QUERY_COUNT ?? '12',
)
const BENCHMARK_MAX_VECTORS_PER_SHARD = Number(
  process.env.YOLO_BENCHMARK_MAX_VECTORS_PER_SHARD ?? '1000',
)
const BENCHMARK_VECTOR_BLOCK_SIZE = Number(
  process.env.YOLO_BENCHMARK_VECTOR_BLOCK_SIZE ?? '256',
)
const BENCHMARK_MEMORY_SAMPLE_MS = Number(
  process.env.YOLO_BENCHMARK_MEMORY_SAMPLE_MS ?? '25',
)
const BENCHMARK_QUERY_MODE = (
  process.env.YOLO_BENCHMARK_QUERY_MODE ?? 'auto'
) as 'auto' | 'live' | 'stored'

type AdapterLike = {
  exists(path: string): Promise<boolean>
  read(path: string): Promise<string>
  readBinary(path: string): Promise<ArrayBuffer>
  write(path: string, data: string): Promise<void>
  writeBinary(path: string, data: ArrayBuffer): Promise<void>
  mkdir(path: string): Promise<void>
  remove(path: string): Promise<void>
  rmdir(path: string, recursive: boolean): Promise<void>
}

type QueryMetrics = {
  query: string
  queryKind: 'chat' | 'harder-stored' | 'self-control' | 'unknown'
  pgliteMs: number
  shardedColdMs: number
  shardedWarmMs: number
  pgliteMemoryDeltaMb: number
  pglitePeakRssDeltaMb: number
  shardedColdMemoryDeltaMb: number
  shardedColdPeakRssDeltaMb: number
  shardedWarmMemoryDeltaMb: number
  shardedWarmPeakRssDeltaMb: number
  shardedColdPhaseTimings: SearchPhaseTimings | null
  shardedWarmPhaseTimings: SearchPhaseTimings | null
  pgliteOverlapVsExactAtK: number
  pglitePathOverlapVsExactAtK: number
  pgliteOrderedPathPrefixMatchVsExactAtK: number
  pgliteAvgRankDisplacementVsExact: number
  pgliteTop1MatchVsExact: boolean
  pgliteFullPathOrderMatchVsExact: boolean
  shardedOverlapVsExactAtK: number
  shardedPathOverlapVsExactAtK: number
  shardedOrderedPathPrefixMatchVsExactAtK: number
  shardedAvgRankDisplacementVsExact: number
  shardedTop1MatchVsExact: boolean
  shardedFullPathOrderMatchVsExact: boolean
  shardedOverlapVsPgliteAtK: number
  shardedPathOverlapVsPgliteAtK: number
  shardedOrderedPathPrefixMatchVsPgliteAtK: number
  shardedAvgRankDisplacementVsPglite: number
  shardedTop1MatchVsPglite: boolean
  shardedFullPathOrderMatchVsPglite: boolean
  pgliteTopPaths: string[]
  exactTopPaths: string[]
  shardedTopPaths: string[]
}

type MemorySnapshot = {
  rssMb: number
  heapTotalMb: number
  heapUsedMb: number
  externalMb: number
  arrayBuffersMb: number
}

type MemoryPeak = MemorySnapshot & {
  samples: number
}

type TimedPhaseResult<T> = {
  result?: T
  durationMs: number
  before: MemorySnapshot
  after: MemorySnapshot
  peak: MemoryPeak
  peakRssDeltaMb: number
  error?: Error
}

const createNodeVaultAdapter = (vaultRoot: string): AdapterLike => {
  const resolvePath = (relativePath: string): string =>
    path.join(vaultRoot, ...relativePath.split('/'))

  const readBinary = async (relativePath: string): Promise<ArrayBuffer> => {
    const buffer = await fs.readFile(resolvePath(relativePath))
    return buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    )
  }

  return {
    async exists(relativePath: string): Promise<boolean> {
      try {
        await fs.access(resolvePath(relativePath))
        return true
      } catch {
        return false
      }
    },
    async read(relativePath: string): Promise<string> {
      return fs.readFile(resolvePath(relativePath), 'utf8')
    },
    async readBinary(relativePath: string): Promise<ArrayBuffer> {
      return readBinary(relativePath)
    },
    async write(relativePath: string, data: string): Promise<void> {
      const absolutePath = resolvePath(relativePath)
      await fs.mkdir(path.dirname(absolutePath), { recursive: true })
      await fs.writeFile(absolutePath, data, 'utf8')
    },
    async writeBinary(relativePath: string, data: ArrayBuffer): Promise<void> {
      const absolutePath = resolvePath(relativePath)
      await fs.mkdir(path.dirname(absolutePath), { recursive: true })
      await fs.writeFile(absolutePath, Buffer.from(data))
    },
    async mkdir(relativePath: string): Promise<void> {
      await fs.mkdir(resolvePath(relativePath), { recursive: true })
    },
    async remove(relativePath: string): Promise<void> {
      await fs.rm(resolvePath(relativePath), { force: true })
    },
    async rmdir(relativePath: string, recursive: boolean): Promise<void> {
      await fs.rm(resolvePath(relativePath), {
        recursive,
        force: true,
      })
    },
  }
}

class MemorySampler {
  private timer: NodeJS.Timeout | null = null
  private peak: MemoryPeak = {
    ...readMemorySnapshot(),
    samples: 0,
  }

  start(): void {
    this.capture()
    this.timer = setInterval(() => this.capture(), BENCHMARK_MEMORY_SAMPLE_MS)
  }

  stop(): MemoryPeak {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.capture()
    return this.peak
  }

  private capture(): void {
    const snapshot = readMemorySnapshot()
    this.peak = {
      rssMb: Math.max(this.peak.rssMb, snapshot.rssMb),
      heapTotalMb: Math.max(this.peak.heapTotalMb, snapshot.heapTotalMb),
      heapUsedMb: Math.max(this.peak.heapUsedMb, snapshot.heapUsedMb),
      externalMb: Math.max(this.peak.externalMb, snapshot.externalMb),
      arrayBuffersMb: Math.max(this.peak.arrayBuffersMb, snapshot.arrayBuffersMb),
      samples: this.peak.samples + 1,
    }
  }
}

const loadSettings = async (): Promise<any> => {
  const raw = await fs.readFile(REAL_SETTINGS_PATH, 'utf8')
  return JSON.parse(raw)
}

const extractCandidateQueries = async (): Promise<BenchmarkQuery[]> => {
  const snapshotDir = path.join(
    REAL_VAULT_ROOT,
    'YOLO/.yolo_json_db/chats/chat_snapshots',
  )
  const files = await fs.readdir(snapshotDir)
  const queries: BenchmarkQuery[] = []
  const seen = new Set<string>()

  for (const file of files) {
    if (!file.endsWith('.json')) {
      continue
    }
    if (queries.length >= BENCHMARK_QUERY_COUNT) {
      break
    }
    const raw = await fs.readFile(path.join(snapshotDir, file), 'utf8')
    const snapshot = JSON.parse(raw) as {
      entries?: Record<
        string,
        {
          content?: Array<{ type?: string; text?: string }>
        }
      >
    }
    for (const entry of Object.values(snapshot.entries ?? {})) {
      for (const item of entry.content ?? []) {
        if (item.type !== 'text' || !item.text) {
          continue
        }
        const stripped = item.text
          .replace(/<user_selected_skills>[\s\S]*?<\/user_selected_skills>/g, '')
          .replace(
            /## Mentioned Vault Files[\s\S]*?This section provides only paths and outlines\.[\s\S]*?\n/g,
            '',
          )
          .trim()
        if (!stripped) {
          continue
        }
        const lines = stripped
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
        for (let index = lines.length - 1; index >= 0; index -= 1) {
          const candidate = lines[index]
          if (
            candidate.length < 4 ||
            candidate.length > 120 ||
            candidate.startsWith('@') ||
            candidate.includes('```') ||
            candidate.startsWith('#') ||
            candidate.startsWith('- ') ||
            candidate.includes('<skill')
          ) {
            continue
          }
          if (seen.has(candidate)) {
            break
          }
          seen.add(candidate)
          queries.push({
            text: candidate,
            source: 'chat-snapshot',
          })
          break
        }
        if (queries.length >= BENCHMARK_QUERY_COUNT) {
          break
        }
      }
      if (queries.length >= BENCHMARK_QUERY_COUNT) {
        break
      }
    }
  }

  return queries
}

const readMemorySnapshot = (): MemorySnapshot => {
  const usage = process.memoryUsage()
  const toMb = (bytes: number): number =>
    Number((bytes / (1024 * 1024)).toFixed(2))

  return {
    rssMb: toMb(usage.rss),
    heapTotalMb: toMb(usage.heapTotal),
    heapUsedMb: toMb(usage.heapUsed),
    externalMb: toMb(usage.external),
    arrayBuffersMb: toMb(usage.arrayBuffers),
  }
}

const memoryDeltaMb = (
  before: MemorySnapshot,
  after: MemorySnapshot,
): number => Number((after.rssMb - before.rssMb).toFixed(2))

const average = (values: number[]): number => {
  if (values.length === 0) {
    return 0
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

const maybeCollectGarbage = (): void => {
  const globalWithGc = globalThis as typeof globalThis & {
    gc?: () => void
  }
  globalWithGc.gc?.()
}

const measurePhase = async <T>(
  execute: () => Promise<T>,
): Promise<TimedPhaseResult<T>> => {
  maybeCollectGarbage()
  const before = readMemorySnapshot()
  const sampler = new MemorySampler()
  sampler.start()
  const startedAt = Date.now()
  try {
    const result = await execute()
    const durationMs = Date.now() - startedAt
    const peak = sampler.stop()
    maybeCollectGarbage()
    const after = readMemorySnapshot()
    return {
      result,
      durationMs,
      before,
      after,
      peak,
      peakRssDeltaMb: Number((peak.rssMb - before.rssMb).toFixed(2)),
    }
  } catch (error) {
    const durationMs = Date.now() - startedAt
    const peak = sampler.stop()
    maybeCollectGarbage()
    const after = readMemorySnapshot()
    return {
      durationMs,
      before,
      after,
      peak,
      peakRssDeltaMb: Number((peak.rssMb - before.rssMb).toFixed(2)),
      error: error instanceof Error ? error : new Error(String(error)),
    }
  }
}

const createPgliteDatabase = async () => {
  const snapshotBytes = await fs.readFile(REAL_PGLITE_SNAPSHOT_PATH)
  const client = await PGlite.create({
    loadDataDir: new Blob([snapshotBytes], { type: 'application/gzip' }),
    extensions: {
      vector: pathToFileURL(
        path.resolve(
          'node_modules/@electric-sql/pglite/dist/vector.tar.gz',
        ),
      ),
    },
  })
  return {
    client,
    db: drizzle(client),
  }
}

const openExistingShardedBackend = async (input: {
  adapter: AdapterLike
}): Promise<ShardedVectorBackend> => {
  const backend = new ShardedVectorBackend({
    app: {
      vault: {
        adapter: input.adapter,
      },
    } as never,
    baseDir: BENCHMARK_BASE_DIR,
    maxVectorsPerShard: BENCHMARK_MAX_VECTORS_PER_SHARD,
    vectorBlockSize: BENCHMARK_VECTOR_BLOCK_SIZE,
    targetCentroidsPerShard: 32,
    maxProbeClusters: 3,
    adaptiveProbeScale: 3,
  })
  await backend.loadManifest()
  return backend
}

const buildShardedSubset = async (input: {
  adapter: AdapterLike
  settings: any
  rows: InsertEmbedding[]
}): Promise<ShardedVectorBackend> => {
  await input.adapter.rmdir(BENCHMARK_BASE_DIR, true)
  const backend = new ShardedVectorBackend({
    app: {
      vault: {
        adapter: input.adapter,
      },
    } as never,
    baseDir: BENCHMARK_BASE_DIR,
    maxVectorsPerShard: BENCHMARK_MAX_VECTORS_PER_SHARD,
    vectorBlockSize: BENCHMARK_VECTOR_BLOCK_SIZE,
    targetCentroidsPerShard: 32,
    maxProbeClusters: 3,
    adaptiveProbeScale: 3,
  })
  await backend.insertVectors(input.rows)
  return backend
}

const mutateRowContent = (row: InsertEmbedding, suffix: string): InsertEmbedding => ({
  ...row,
  mtime: Number(row.mtime) + 1,
  content: `${row.content}${suffix}`,
})

runRealBenchmark('real vault vector backend benchmark', () => {
  jest.setTimeout(30 * 60 * 1000)

  it('compares pglite and sharded retrieval on a real vault subset', async () => {
    const settings = await loadSettings()
    const embeddingModelId = settings.embeddingModelId as string
    const embeddingModel = settings.embeddingModels.find(
      (model: any) => model.id === embeddingModelId,
    )
    if (!embeddingModel) {
      throw new Error(`Embedding model "${embeddingModelId}" not found in settings`)
    }

    const adapter = createNodeVaultAdapter(REAL_VAULT_ROOT)
    const benchmarkMemory: Record<string, MemorySnapshot> = {}
    const pgliteLoadPhase = await measurePhase(() => createPgliteDatabase())
    if (pgliteLoadPhase.error || !pgliteLoadPhase.result) {
      throw pgliteLoadPhase.error ?? new Error('Failed to load pglite database')
    }
    benchmarkMemory.beforePgliteLoad = pgliteLoadPhase.before
    benchmarkMemory.afterPgliteLoad = pgliteLoadPhase.after
    const { client, db } = pgliteLoadPhase.result
    const pgliteBackend = new PgliteVectorBackend({} as never, db)

    try {
      maybeCollectGarbage()
      benchmarkMemory.beforeSourceRows = readMemorySnapshot()

      const sourceRows = await db
        .select()
        .from(embeddingTable)
        .where(
          and(
            eq(embeddingTable.model, embeddingModel.id),
            eq(embeddingTable.dimension, embeddingModel.dimension),
          ),
        )
        .orderBy(asc(embeddingTable.id))
        .limit(BENCHMARK_MAX_ROWS)

      if (sourceRows.length === 0) {
        throw new Error('No embedding rows available for the configured model')
      }
      maybeCollectGarbage()
      benchmarkMemory.afterSourceRows = readMemorySnapshot()

      const pgliteDumpPhase = await measurePhase(async () => {
        const dumpBlob = await client.dumpDataDir('gzip')
        const dumpArrayBuffer = await dumpBlob.arrayBuffer()
        return {
          gzipBytes: dumpBlob.size,
          arrayBufferBytes: dumpArrayBuffer.byteLength,
        }
      })
      benchmarkMemory.beforePgliteDump = pgliteDumpPhase.before
      benchmarkMemory.afterPgliteDump = pgliteDumpPhase.after

      const shardedRows: InsertEmbedding[] = sourceRows.map((row) => ({
        path: row.path,
        mtime: row.mtime,
        content: row.content,
        content_hash: row.content_hash,
        model: row.model,
        dimension: row.dimension,
        embedding: row.embedding ?? undefined,
        metadata: row.metadata,
      }))

      maybeCollectGarbage()
      benchmarkMemory.beforeShardedBuild = readMemorySnapshot()
      const shardedBuildPhase = await measurePhase(() =>
        buildShardedSubset({
          adapter,
          settings,
          rows: shardedRows,
        }),
      )
      if (shardedBuildPhase.error || !shardedBuildPhase.result) {
        throw shardedBuildPhase.error ?? new Error('Sharded build failed')
      }
      const shardedBackend = shardedBuildPhase.result
      benchmarkMemory.afterShardedBuild = shardedBuildPhase.after
      const shardedManifestLoadPhase = await measurePhase(() =>
        openExistingShardedBackend({
          adapter,
        }),
      )
      if (shardedManifestLoadPhase.error || !shardedManifestLoadPhase.result) {
        throw (
          shardedManifestLoadPhase.error ??
          new Error('Failed to reopen sharded backend')
        )
      }
      benchmarkMemory.beforeShardedManifestLoad = shardedManifestLoadPhase.before
      benchmarkMemory.afterShardedManifestLoad = shardedManifestLoadPhase.after

      const embeddingClient = getEmbeddingModelClient({
        settings,
        embeddingModelId,
      })

      let queryTexts =
        BENCHMARK_QUERY_MODE === 'stored' ? [] : await extractCandidateQueries()
      let queryMode: 'live-embedding' | 'stored-vector-fallback' =
        BENCHMARK_QUERY_MODE === 'stored'
          ? 'stored-vector-fallback'
          : 'live-embedding'
      if (
        BENCHMARK_QUERY_MODE !== 'live' &&
        queryTexts.length === 0
      ) {
        queryTexts = buildHarderStoredVectorQueries(
          sourceRows,
          BENCHMARK_QUERY_COUNT,
        )
        if (queryTexts.length === 0) {
          queryTexts = buildFallbackQueriesFromRows(
            sourceRows,
            BENCHMARK_QUERY_COUNT,
          )
        }
        queryMode = 'stored-vector-fallback'
      }
      if (queryTexts.length === 0) {
        throw new Error(
          'No usable real query texts or stored-vector fallback queries were available',
        )
      }

      const metrics: QueryMetrics[] = []
      for (const query of queryTexts) {
        let vector = query.vector
        if (!vector) {
          try {
            vector = await embeddingClient.getEmbedding(query.text)
          } catch (error) {
            if (
              BENCHMARK_QUERY_MODE === 'live'
            ) {
              throw error
            }
            if (queryMode !== 'stored-vector-fallback') {
              queryTexts = buildHarderStoredVectorQueries(
                sourceRows,
                BENCHMARK_QUERY_COUNT,
              )
              if (queryTexts.length === 0) {
                queryTexts = buildFallbackQueriesFromRows(
                  sourceRows,
                  BENCHMARK_QUERY_COUNT,
                )
              }
              queryMode = 'stored-vector-fallback'
            }
            if (queryTexts.length === 0) {
              throw error
            }
            const fallbackQuery = queryTexts[metrics.length]
            if (!fallbackQuery?.vector) {
              throw error
            }
            vector = fallbackQuery.vector
            query.text = fallbackQuery.text
          }
        }

        const pglitePhase = await measurePhase(() =>
          pgliteBackend.performSimilaritySearch(vector, embeddingClient, {
            minSimilarity: Number(settings.ragOptions?.minSimilarity ?? 0),
            limit: Number(settings.ragOptions?.limit ?? 10),
          }),
        )
        if (pglitePhase.error || !pglitePhase.result) {
          throw pglitePhase.error ?? new Error('PGlite query failed')
        }
        const pgliteResults = pglitePhase.result

        const shardedColdPhase = await measurePhase(() =>
          shardedBackend.performSimilaritySearch(vector, embeddingClient, {
            minSimilarity: Number(settings.ragOptions?.minSimilarity ?? 0),
            limit: Number(settings.ragOptions?.limit ?? 10),
          }),
        )
        if (shardedColdPhase.error || !shardedColdPhase.result) {
          throw shardedColdPhase.error ?? new Error('Sharded cold query failed')
        }
        const shardedColdResults = shardedColdPhase.result
        const shardedColdPhaseTimings =
          shardedBackend.getLastSearchPhaseTimings()

        const shardedWarmPhase = await measurePhase(() =>
          shardedBackend.performSimilaritySearch(vector, embeddingClient, {
            minSimilarity: Number(settings.ragOptions?.minSimilarity ?? 0),
            limit: Number(settings.ragOptions?.limit ?? 10),
          }),
        )
        if (shardedWarmPhase.error || !shardedWarmPhase.result) {
          throw shardedWarmPhase.error ?? new Error('Sharded warm query failed')
        }
        const shardedWarmResults = shardedWarmPhase.result
        const shardedWarmPhaseTimings =
          shardedBackend.getLastSearchPhaseTimings()
        const exactResults = computeExactTopK({
          queryVector: vector,
          rows: sourceRows.map((row) => ({
            path: row.path,
            content: row.content,
            content_hash: row.content_hash,
            embedding: row.embedding ?? null,
          })),
          minSimilarity: Number(settings.ragOptions?.minSimilarity ?? 0),
          limit: Number(settings.ragOptions?.limit ?? 10),
          model: embeddingModel.id,
          dimension: embeddingModel.dimension,
        })

        const pgliteHits = pgliteResults.map((row) => ({
          path: row.path,
          content_hash: row.content_hash,
        }))
        const shardedHits = shardedColdResults.map((row) => ({
          path: row.path,
          content_hash: row.content_hash,
        }))
        const exactHits: SearchHit[] = exactResults.map((row) => ({
          path: row.path,
          content_hash: row.content_hash,
        }))
        const comparisons = computeQueryComparisons({
          exactResults: exactHits,
          pgliteResults: pgliteHits,
          shardedResults: shardedHits,
        })
        const pgliteTopPaths = pgliteResults.map((row) => row.path)
        const exactTopPaths = exactResults.map((row) => row.path)
        const shardedTopPaths = shardedColdResults.map((row) => row.path)

        metrics.push({
          query: query.text,
          queryKind: classifyBenchmarkQuery(query),
          pgliteMs: pglitePhase.durationMs,
          shardedColdMs: shardedColdPhase.durationMs,
          shardedWarmMs: shardedWarmPhase.durationMs,
          pgliteMemoryDeltaMb: memoryDeltaMb(pglitePhase.before, pglitePhase.after),
          pglitePeakRssDeltaMb: pglitePhase.peakRssDeltaMb,
          shardedColdMemoryDeltaMb: memoryDeltaMb(
            shardedColdPhase.before,
            shardedColdPhase.after,
          ),
          shardedColdPeakRssDeltaMb: shardedColdPhase.peakRssDeltaMb,
          shardedColdPhaseTimings,
          shardedWarmMemoryDeltaMb: memoryDeltaMb(
            shardedWarmPhase.before,
            shardedWarmPhase.after,
          ),
          shardedWarmPeakRssDeltaMb: shardedWarmPhase.peakRssDeltaMb,
          shardedWarmPhaseTimings,
          pgliteOverlapVsExactAtK: comparisons.pgliteOverlapVsExactAtK,
          pglitePathOverlapVsExactAtK: comparisons.pglitePathOverlapVsExactAtK,
          pgliteOrderedPathPrefixMatchVsExactAtK:
            comparisons.pgliteOrderedPathPrefixMatchVsExactAtK,
          pgliteAvgRankDisplacementVsExact:
            comparisons.pgliteAvgRankDisplacementVsExact,
          pgliteTop1MatchVsExact: comparisons.pgliteTop1MatchVsExact,
          pgliteFullPathOrderMatchVsExact:
            comparisons.pgliteFullPathOrderMatchVsExact,
          shardedOverlapVsExactAtK: comparisons.shardedOverlapVsExactAtK,
          shardedPathOverlapVsExactAtK: comparisons.shardedPathOverlapVsExactAtK,
          shardedOrderedPathPrefixMatchVsExactAtK:
            comparisons.shardedOrderedPathPrefixMatchVsExactAtK,
          shardedAvgRankDisplacementVsExact:
            comparisons.shardedAvgRankDisplacementVsExact,
          shardedTop1MatchVsExact: comparisons.shardedTop1MatchVsExact,
          shardedFullPathOrderMatchVsExact:
            comparisons.shardedFullPathOrderMatchVsExact,
          shardedOverlapVsPgliteAtK: comparisons.shardedOverlapVsPgliteAtK,
          shardedPathOverlapVsPgliteAtK:
            comparisons.shardedPathOverlapVsPgliteAtK,
          shardedOrderedPathPrefixMatchVsPgliteAtK:
            comparisons.shardedOrderedPathPrefixMatchVsPgliteAtK,
          shardedAvgRankDisplacementVsPglite:
            comparisons.shardedAvgRankDisplacementVsPglite,
          shardedTop1MatchVsPglite: comparisons.shardedTop1MatchVsPglite,
          shardedFullPathOrderMatchVsPglite:
            comparisons.shardedFullPathOrderMatchVsPglite,
          pgliteTopPaths,
          exactTopPaths,
          shardedTopPaths,
        })
      }

      const shardedUpdateRows = shardedRows
        .slice(0, Math.min(50, Math.max(10, Math.floor(shardedRows.length * 0.01))))
        .map((row, index) =>
          mutateRowContent(
            row,
            `\n[benchmark update ${index}]`,
          ),
        )
      const shardedDeletePaths = shardedRows
        .slice(
          Math.max(
            shardedUpdateRows.length,
            shardedRows.length -
              Math.min(50, Math.max(10, Math.floor(shardedRows.length * 0.01))),
          ),
        )
        .map((row) => row.path)

      const pgliteIncrementalUpdatePhase = await measurePhase(async () => {
        const existingRows = await pgliteBackend.listChunksForPaths(
          embeddingModel.id,
          shardedUpdateRows.map((row) => row.path),
        )
        await pgliteBackend.deleteVectorsByIds(existingRows.map((row) => row.id))
        await pgliteBackend.insertVectors(shardedUpdateRows)
        return {
          updatedPaths: shardedUpdateRows.length,
        }
      })
      if (pgliteIncrementalUpdatePhase.error) {
        throw (
          pgliteIncrementalUpdatePhase.error ??
          new Error('PGlite incremental update benchmark phase failed')
        )
      }

      const pgliteIncrementalDeletePhase = await measurePhase(async () => {
        await pgliteBackend.deleteVectorsByPaths(
          embeddingModel.id,
          shardedDeletePaths,
        )
        return {
          deletedPaths: shardedDeletePaths.length,
        }
      })
      if (pgliteIncrementalDeletePhase.error) {
        throw (
          pgliteIncrementalDeletePhase.error ??
          new Error('PGlite incremental delete benchmark phase failed')
        )
      }

      const shardedIncrementalUpdatePhase = await measurePhase(async () => {
        const existingRows = await shardedBackend.listChunksForPaths(
          embeddingModel.id,
          shardedUpdateRows.map((row) => row.path),
        )
        await shardedBackend.deleteVectorsByIds(existingRows.map((row) => row.id))
        await shardedBackend.insertVectors(shardedUpdateRows)
        return {
          updatedPaths: shardedUpdateRows.length,
        }
      })
      if (shardedIncrementalUpdatePhase.error) {
        throw (
          shardedIncrementalUpdatePhase.error ??
          new Error('Sharded incremental update benchmark phase failed')
        )
      }

      const shardedIncrementalDeletePhase = await measurePhase(async () => {
        await shardedBackend.deleteVectorsByPaths(
          embeddingModel.id,
          shardedDeletePaths,
        )
        return {
          deletedPaths: shardedDeletePaths.length,
        }
      })
      if (shardedIncrementalDeletePhase.error) {
        throw (
          shardedIncrementalDeletePhase.error ??
          new Error('Sharded incremental delete benchmark phase failed')
        )
      }

      const aggregate: RealVaultBenchmarkAggregate = {
        vaultRoot: REAL_VAULT_ROOT,
        embeddingModelId,
        queryMode,
        sampledRowCount: sourceRows.length,
        queryCount: metrics.length,
        vectorBlockSize: BENCHMARK_VECTOR_BLOCK_SIZE,
        avgPgliteMs:
          metrics.reduce((sum, item) => sum + item.pgliteMs, 0) / metrics.length,
        avgShardedColdMs:
          metrics.reduce((sum, item) => sum + item.shardedColdMs, 0) /
          metrics.length,
        avgShardedWarmMs:
          metrics.reduce((sum, item) => sum + item.shardedWarmMs, 0) /
          metrics.length,
        avgPgliteMemoryDeltaMb:
          metrics.reduce((sum, item) => sum + item.pgliteMemoryDeltaMb, 0) /
          metrics.length,
        avgPglitePeakRssDeltaMb:
          metrics.reduce((sum, item) => sum + item.pglitePeakRssDeltaMb, 0) /
          metrics.length,
        avgShardedColdMemoryDeltaMb:
          metrics.reduce((sum, item) => sum + item.shardedColdMemoryDeltaMb, 0) /
          metrics.length,
        avgShardedColdPeakRssDeltaMb:
          metrics.reduce((sum, item) => sum + item.shardedColdPeakRssDeltaMb, 0) /
          metrics.length,
        avgShardedWarmMemoryDeltaMb:
          metrics.reduce((sum, item) => sum + item.shardedWarmMemoryDeltaMb, 0) /
          metrics.length,
        avgShardedWarmPeakRssDeltaMb:
          metrics.reduce((sum, item) => sum + item.shardedWarmPeakRssDeltaMb, 0) /
          metrics.length,
        avgShardedColdManifestLoadMs: average(
          metrics.map(
            (item) => item.shardedColdPhaseTimings?.manifestLoadMs ?? 0,
          ),
        ),
        avgShardedColdShardPrefilterMs: average(
          metrics.map(
            (item) => item.shardedColdPhaseTimings?.shardPrefilterMs ?? 0,
          ),
        ),
        avgShardedColdIndexLoadMs: average(
          metrics.map((item) => item.shardedColdPhaseTimings?.indexLoadMs ?? 0),
        ),
        avgShardedColdCandidateSelectionMs: average(
          metrics.map(
            (item) => item.shardedColdPhaseTimings?.candidateSelectionMs ?? 0,
          ),
        ),
        avgShardedColdTombstoneLoadMs: average(
          metrics.map(
            (item) => item.shardedColdPhaseTimings?.tombstoneLoadMs ?? 0,
          ),
        ),
        avgShardedColdRowBlockLoadMs: average(
          metrics.map(
            (item) => item.shardedColdPhaseTimings?.rowBlockLoadMs ?? 0,
          ),
        ),
        avgShardedColdVectorBlockLoadMs: average(
          metrics.map(
            (item) => item.shardedColdPhaseTimings?.vectorBlockLoadMs ?? 0,
          ),
        ),
        avgShardedColdRerankMs: average(
          metrics.map((item) => item.shardedColdPhaseTimings?.rerankMs ?? 0),
        ),
        avgShardedColdDedupeSortMs: average(
          metrics.map(
            (item) => item.shardedColdPhaseTimings?.dedupeSortMs ?? 0,
          ),
        ),
        avgShardedWarmManifestLoadMs: average(
          metrics.map(
            (item) => item.shardedWarmPhaseTimings?.manifestLoadMs ?? 0,
          ),
        ),
        avgShardedWarmShardPrefilterMs: average(
          metrics.map(
            (item) => item.shardedWarmPhaseTimings?.shardPrefilterMs ?? 0,
          ),
        ),
        avgShardedWarmIndexLoadMs: average(
          metrics.map((item) => item.shardedWarmPhaseTimings?.indexLoadMs ?? 0),
        ),
        avgShardedWarmCandidateSelectionMs: average(
          metrics.map(
            (item) => item.shardedWarmPhaseTimings?.candidateSelectionMs ?? 0,
          ),
        ),
        avgShardedWarmTombstoneLoadMs: average(
          metrics.map(
            (item) => item.shardedWarmPhaseTimings?.tombstoneLoadMs ?? 0,
          ),
        ),
        avgShardedWarmRowBlockLoadMs: average(
          metrics.map(
            (item) => item.shardedWarmPhaseTimings?.rowBlockLoadMs ?? 0,
          ),
        ),
        avgShardedWarmVectorBlockLoadMs: average(
          metrics.map(
            (item) => item.shardedWarmPhaseTimings?.vectorBlockLoadMs ?? 0,
          ),
        ),
        avgShardedWarmRerankMs: average(
          metrics.map((item) => item.shardedWarmPhaseTimings?.rerankMs ?? 0),
        ),
        avgShardedWarmDedupeSortMs: average(
          metrics.map(
            (item) => item.shardedWarmPhaseTimings?.dedupeSortMs ?? 0,
          ),
        ),
        avgPgliteOverlapVsExactAtK:
          metrics.reduce((sum, item) => sum + item.pgliteOverlapVsExactAtK, 0) /
          metrics.length,
        avgPglitePathOverlapVsExactAtK:
          metrics.reduce(
            (sum, item) => sum + item.pglitePathOverlapVsExactAtK,
            0,
          ) / metrics.length,
        avgPgliteOrderedPathPrefixMatchVsExactAtK:
          metrics.reduce(
            (sum, item) => sum + item.pgliteOrderedPathPrefixMatchVsExactAtK,
            0,
          ) / metrics.length,
        avgPgliteRankDisplacementVsExact:
          metrics.reduce(
            (sum, item) => sum + item.pgliteAvgRankDisplacementVsExact,
            0,
          ) / metrics.length,
        avgShardedOverlapVsExactAtK:
          metrics.reduce((sum, item) => sum + item.shardedOverlapVsExactAtK, 0) /
          metrics.length,
        avgShardedPathOverlapVsExactAtK:
          metrics.reduce(
            (sum, item) => sum + item.shardedPathOverlapVsExactAtK,
            0,
          ) / metrics.length,
        avgShardedOrderedPathPrefixMatchVsExactAtK:
          metrics.reduce(
            (sum, item) => sum + item.shardedOrderedPathPrefixMatchVsExactAtK,
            0,
          ) / metrics.length,
        avgShardedRankDisplacementVsExact:
          metrics.reduce(
            (sum, item) => sum + item.shardedAvgRankDisplacementVsExact,
            0,
          ) / metrics.length,
        avgShardedOverlapVsPgliteAtK:
          metrics.reduce((sum, item) => sum + item.shardedOverlapVsPgliteAtK, 0) /
          metrics.length,
        avgShardedPathOverlapVsPgliteAtK:
          metrics.reduce(
            (sum, item) => sum + item.shardedPathOverlapVsPgliteAtK,
            0,
          ) / metrics.length,
        avgShardedOrderedPathPrefixMatchVsPgliteAtK:
          metrics.reduce(
            (sum, item) => sum + item.shardedOrderedPathPrefixMatchVsPgliteAtK,
            0,
          ) / metrics.length,
        avgShardedRankDisplacementVsPglite:
          metrics.reduce(
            (sum, item) => sum + item.shardedAvgRankDisplacementVsPglite,
            0,
          ) / metrics.length,
        pgliteTop1MatchVsExactRate:
          metrics.filter((item) => item.pgliteTop1MatchVsExact).length /
          metrics.length,
        shardedTop1MatchVsExactRate:
          metrics.filter((item) => item.shardedTop1MatchVsExact).length /
          metrics.length,
        shardedTop1MatchVsPgliteRate:
          metrics.filter((item) => item.shardedTop1MatchVsPglite).length /
          metrics.length,
        pgliteFullPathOrderMatchVsExactRate:
          metrics.filter((item) => item.pgliteFullPathOrderMatchVsExact).length /
          metrics.length,
        shardedFullPathOrderMatchVsExactRate:
          metrics.filter((item) => item.shardedFullPathOrderMatchVsExact).length /
          metrics.length,
        shardedFullPathOrderMatchVsPgliteRate:
          metrics.filter((item) => item.shardedFullPathOrderMatchVsPglite).length /
          metrics.length,
        buildMemoryDeltaMb: memoryDeltaMb(
          benchmarkMemory.beforeShardedBuild,
          benchmarkMemory.afterShardedBuild,
        ),
        buildPeakRssDeltaMb: shardedBuildPhase.peakRssDeltaMb,
        buildDurationMs: shardedBuildPhase.durationMs,
        pgliteIncrementalUpdateDurationMs: pgliteIncrementalUpdatePhase.durationMs,
        pgliteIncrementalUpdateMemoryDeltaMb: memoryDeltaMb(
          pgliteIncrementalUpdatePhase.before,
          pgliteIncrementalUpdatePhase.after,
        ),
        pgliteIncrementalUpdatePeakRssDeltaMb:
          pgliteIncrementalUpdatePhase.peakRssDeltaMb,
        pgliteIncrementalDeleteDurationMs: pgliteIncrementalDeletePhase.durationMs,
        pgliteIncrementalDeleteMemoryDeltaMb: memoryDeltaMb(
          pgliteIncrementalDeletePhase.before,
          pgliteIncrementalDeletePhase.after,
        ),
        pgliteIncrementalDeletePeakRssDeltaMb:
          pgliteIncrementalDeletePhase.peakRssDeltaMb,
        shardedIncrementalUpdateDurationMs:
          shardedIncrementalUpdatePhase.durationMs,
        shardedIncrementalUpdateMemoryDeltaMb: memoryDeltaMb(
          shardedIncrementalUpdatePhase.before,
          shardedIncrementalUpdatePhase.after,
        ),
        shardedIncrementalUpdatePeakRssDeltaMb:
          shardedIncrementalUpdatePhase.peakRssDeltaMb,
        shardedIncrementalDeleteDurationMs:
          shardedIncrementalDeletePhase.durationMs,
        shardedIncrementalDeleteMemoryDeltaMb: memoryDeltaMb(
          shardedIncrementalDeletePhase.before,
          shardedIncrementalDeletePhase.after,
        ),
        shardedIncrementalDeletePeakRssDeltaMb:
          shardedIncrementalDeletePhase.peakRssDeltaMb,
        pgliteLoadDurationMs: pgliteLoadPhase.durationMs,
        pgliteLoadMemoryDeltaMb: memoryDeltaMb(
          pgliteLoadPhase.before,
          pgliteLoadPhase.after,
        ),
        pgliteLoadPeakRssDeltaMb: pgliteLoadPhase.peakRssDeltaMb,
        sourceRowLoadMemoryDeltaMb: memoryDeltaMb(
          benchmarkMemory.beforeSourceRows,
          benchmarkMemory.afterSourceRows,
        ),
        pgliteDumpDurationMs: pgliteDumpPhase.durationMs,
        pgliteDumpMemoryDeltaMb: memoryDeltaMb(
          pgliteDumpPhase.before,
          pgliteDumpPhase.after,
        ),
        pgliteDumpPeakRssDeltaMb: pgliteDumpPhase.peakRssDeltaMb,
        pgliteDumpSucceeded: !pgliteDumpPhase.error,
        pgliteDumpError: pgliteDumpPhase.error?.message ?? null,
        pgliteDumpGzipBytes: pgliteDumpPhase.result?.gzipBytes ?? null,
        pgliteDumpArrayBufferBytes:
          pgliteDumpPhase.result?.arrayBufferBytes ?? null,
        shardedManifestLoadDurationMs: shardedManifestLoadPhase.durationMs,
        shardedManifestLoadMemoryDeltaMb: memoryDeltaMb(
          shardedManifestLoadPhase.before,
          shardedManifestLoadPhase.after,
        ),
        shardedManifestLoadPeakRssDeltaMb:
          shardedManifestLoadPhase.peakRssDeltaMb,
        shardCountEstimate:
          Math.ceil(sourceRows.length / BENCHMARK_MAX_VECTORS_PER_SHARD) || 0,
      }
      const analysis = analyzeShardedBenchmark(aggregate)
      const metricsByQueryKind = groupMetricsByQueryKind(metrics)
      const groupedSummary = Object.fromEntries(
        Object.entries(metricsByQueryKind)
          .filter(([, items]) => items.length > 0)
          .map(([kind, items]) => [kind, aggregateMetrics(items)]),
      )

      console.log(
        '[YOLO][Benchmark][RealVault]',
        JSON.stringify(
          {
            aggregate,
            groupedSummary,
            analysis,
            benchmarkMemory,
            metrics,
          },
          null,
          2,
        ),
      )
      const benchmarkOutputPath = process.env.YOLO_BENCHMARK_OUTPUT_PATH
      if (benchmarkOutputPath) {
        await fs.mkdir(path.dirname(benchmarkOutputPath), { recursive: true })
        await fs.writeFile(
          benchmarkOutputPath,
          JSON.stringify(
            {
              aggregate,
              groupedSummary,
              analysis,
              benchmarkMemory,
              metrics,
            },
            null,
            2,
          ),
          'utf8',
        )
      }

      expect(metrics.length).toBeGreaterThan(0)
    } finally {
      await client.close()
    }
  })
})
