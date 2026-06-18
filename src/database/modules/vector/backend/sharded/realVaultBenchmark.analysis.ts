export type RealVaultBenchmarkAggregate = {
  vaultRoot?: string
  embeddingModelId?: string
  queryMode?: string
  vectorBlockSize?: number
  sampledRowCount: number
  queryCount: number
  shardCountEstimate: number
  avgPgliteMs: number
  avgShardedColdMs: number
  avgShardedWarmMs: number
  avgPgliteMemoryDeltaMb: number
  avgPglitePeakRssDeltaMb: number
  avgShardedColdMemoryDeltaMb: number
  avgShardedColdPeakRssDeltaMb: number
  avgShardedWarmMemoryDeltaMb: number
  avgShardedWarmPeakRssDeltaMb: number
  avgShardedColdManifestLoadMs?: number
  avgShardedColdShardPrefilterMs?: number
  avgShardedColdIndexLoadMs?: number
  avgShardedColdCandidateSelectionMs?: number
  avgShardedColdTombstoneLoadMs?: number
  avgShardedColdRowBlockLoadMs?: number
  avgShardedColdVectorBlockLoadMs?: number
  avgShardedColdRerankMs?: number
  avgShardedColdDedupeSortMs?: number
  avgShardedWarmManifestLoadMs?: number
  avgShardedWarmShardPrefilterMs?: number
  avgShardedWarmIndexLoadMs?: number
  avgShardedWarmCandidateSelectionMs?: number
  avgShardedWarmTombstoneLoadMs?: number
  avgShardedWarmRowBlockLoadMs?: number
  avgShardedWarmVectorBlockLoadMs?: number
  avgShardedWarmRerankMs?: number
  avgShardedWarmDedupeSortMs?: number
  avgPgliteOverlapVsExactAtK: number
  avgPglitePathOverlapVsExactAtK: number
  avgPgliteOrderedPathPrefixMatchVsExactAtK: number
  avgPgliteRankDisplacementVsExact: number
  avgShardedOverlapVsExactAtK: number
  avgShardedPathOverlapVsExactAtK: number
  avgShardedOrderedPathPrefixMatchVsExactAtK: number
  avgShardedRankDisplacementVsExact: number
  avgShardedOverlapVsPgliteAtK: number
  avgShardedPathOverlapVsPgliteAtK: number
  avgShardedOrderedPathPrefixMatchVsPgliteAtK: number
  avgShardedRankDisplacementVsPglite: number
  pgliteTop1MatchVsExactRate: number
  shardedTop1MatchVsExactRate: number
  shardedTop1MatchVsPgliteRate: number
  pgliteFullPathOrderMatchVsExactRate: number
  shardedFullPathOrderMatchVsExactRate: number
  shardedFullPathOrderMatchVsPgliteRate: number
  buildMemoryDeltaMb: number
  buildPeakRssDeltaMb: number
  buildDurationMs: number
  pgliteIncrementalUpdateDurationMs?: number
  pgliteIncrementalUpdateMemoryDeltaMb?: number
  pgliteIncrementalUpdatePeakRssDeltaMb?: number
  pgliteIncrementalDeleteDurationMs?: number
  pgliteIncrementalDeleteMemoryDeltaMb?: number
  pgliteIncrementalDeletePeakRssDeltaMb?: number
  shardedIncrementalUpdateDurationMs?: number
  shardedIncrementalUpdateMemoryDeltaMb?: number
  shardedIncrementalUpdatePeakRssDeltaMb?: number
  shardedIncrementalDeleteDurationMs?: number
  shardedIncrementalDeleteMemoryDeltaMb?: number
  shardedIncrementalDeletePeakRssDeltaMb?: number
  sourceRowLoadMemoryDeltaMb: number
  pgliteLoadDurationMs: number
  pgliteLoadMemoryDeltaMb: number
  pgliteLoadPeakRssDeltaMb: number
  pgliteDumpDurationMs: number
  pgliteDumpMemoryDeltaMb: number
  pgliteDumpPeakRssDeltaMb: number
  pgliteDumpSucceeded: boolean
  pgliteDumpError: string | null
  pgliteDumpGzipBytes: number | null
  pgliteDumpArrayBufferBytes: number | null
  shardedManifestLoadDurationMs: number
  shardedManifestLoadMemoryDeltaMb: number
  shardedManifestLoadPeakRssDeltaMb: number
}

export type RealVaultBenchmarkAnalysis = {
  stageFindings: string[]
  benchmarkGaps: string[]
  shardedImprovements: string[]
}

const mb = (value: number | null | undefined): string =>
  `${Number(value ?? 0).toFixed(2)} MB`

const ms = (value: number): string => `${Number(value).toFixed(1)} ms`

const getDominantShardedPhase = (
  aggregate: RealVaultBenchmarkAggregate,
  mode: 'cold' | 'warm',
): { label: string; value: number } | null => {
  const phases: Array<{ label: string; value: number }> =
    mode === 'cold'
      ? [
          { label: 'manifest', value: aggregate.avgShardedColdManifestLoadMs ?? 0 },
          {
            label: 'shard prefilter',
            value: aggregate.avgShardedColdShardPrefilterMs ?? 0,
          },
          { label: 'index load', value: aggregate.avgShardedColdIndexLoadMs ?? 0 },
          {
            label: 'candidate selection',
            value: aggregate.avgShardedColdCandidateSelectionMs ?? 0,
          },
          {
            label: 'tombstone load',
            value: aggregate.avgShardedColdTombstoneLoadMs ?? 0,
          },
          {
            label: 'row block load',
            value: aggregate.avgShardedColdRowBlockLoadMs ?? 0,
          },
          {
            label: 'vector block load',
            value: aggregate.avgShardedColdVectorBlockLoadMs ?? 0,
          },
          { label: 'rerank', value: aggregate.avgShardedColdRerankMs ?? 0 },
          {
            label: 'dedupe/sort',
            value: aggregate.avgShardedColdDedupeSortMs ?? 0,
          },
        ]
      : [
          { label: 'manifest', value: aggregate.avgShardedWarmManifestLoadMs ?? 0 },
          {
            label: 'shard prefilter',
            value: aggregate.avgShardedWarmShardPrefilterMs ?? 0,
          },
          { label: 'index load', value: aggregate.avgShardedWarmIndexLoadMs ?? 0 },
          {
            label: 'candidate selection',
            value: aggregate.avgShardedWarmCandidateSelectionMs ?? 0,
          },
          {
            label: 'tombstone load',
            value: aggregate.avgShardedWarmTombstoneLoadMs ?? 0,
          },
          {
            label: 'row block load',
            value: aggregate.avgShardedWarmRowBlockLoadMs ?? 0,
          },
          {
            label: 'vector block load',
            value: aggregate.avgShardedWarmVectorBlockLoadMs ?? 0,
          },
          { label: 'rerank', value: aggregate.avgShardedWarmRerankMs ?? 0 },
          {
            label: 'dedupe/sort',
            value: aggregate.avgShardedWarmDedupeSortMs ?? 0,
          },
        ]

  const dominant = phases.reduce<{ label: string; value: number } | null>(
    (best, current) => {
      if (!best || current.value > best.value) {
        return current
      }
      return best
    },
    null,
  )

  if (!dominant || dominant.value <= 0) {
    return null
  }

  return dominant
}

export const analyzeShardedBenchmark = (
  aggregate: RealVaultBenchmarkAggregate,
): RealVaultBenchmarkAnalysis => {
  const dominantColdPhase = getDominantShardedPhase(aggregate, 'cold')
  const dominantWarmPhase = getDominantShardedPhase(aggregate, 'warm')
  const stageFindings: string[] = [
    `pglite load: ${ms(aggregate.pgliteLoadDurationMs)}, peak RSS delta ${mb(aggregate.pgliteLoadPeakRssDeltaMb)}.`,
    `pglite dump/save: ${ms(aggregate.pgliteDumpDurationMs)}, gzip ${mb(
      aggregate.pgliteDumpGzipBytes == null
        ? null
        : aggregate.pgliteDumpGzipBytes / (1024 * 1024),
    )}, peak RSS delta ${mb(aggregate.pgliteDumpPeakRssDeltaMb)}.`,
    `pglite incremental update: ${ms(aggregate.pgliteIncrementalUpdateDurationMs ?? 0)}, peak RSS delta ${mb(aggregate.pgliteIncrementalUpdatePeakRssDeltaMb)}.`,
    `pglite incremental delete: ${ms(aggregate.pgliteIncrementalDeleteDurationMs ?? 0)}, peak RSS delta ${mb(aggregate.pgliteIncrementalDeletePeakRssDeltaMb)}.`,
    `sharded manifest load: ${ms(aggregate.shardedManifestLoadDurationMs)}, peak RSS delta ${mb(aggregate.shardedManifestLoadPeakRssDeltaMb)}.`,
    `sharded build: ${ms(aggregate.buildDurationMs)}, peak RSS delta ${mb(aggregate.buildPeakRssDeltaMb)}.`,
    `sharded incremental update: ${ms(aggregate.shardedIncrementalUpdateDurationMs ?? 0)}, peak RSS delta ${mb(aggregate.shardedIncrementalUpdatePeakRssDeltaMb)}.`,
    `sharded incremental delete: ${ms(aggregate.shardedIncrementalDeleteDurationMs ?? 0)}, peak RSS delta ${mb(aggregate.shardedIncrementalDeletePeakRssDeltaMb)}.`,
    `query path: pglite avg ${ms(aggregate.avgPgliteMs)}, sharded cold avg ${ms(aggregate.avgShardedColdMs)}, sharded warm avg ${ms(aggregate.avgShardedWarmMs)}.`,
    `sharded cold query phases: manifest ${ms(aggregate.avgShardedColdManifestLoadMs ?? 0)}, prefilter ${ms(aggregate.avgShardedColdShardPrefilterMs ?? 0)}, index ${ms(aggregate.avgShardedColdIndexLoadMs ?? 0)}, candidate select ${ms(aggregate.avgShardedColdCandidateSelectionMs ?? 0)}, tombstones ${ms(aggregate.avgShardedColdTombstoneLoadMs ?? 0)}, row blocks ${ms(aggregate.avgShardedColdRowBlockLoadMs ?? 0)}, vector blocks ${ms(aggregate.avgShardedColdVectorBlockLoadMs ?? 0)}, rerank ${ms(aggregate.avgShardedColdRerankMs ?? 0)}, dedupe/sort ${ms(aggregate.avgShardedColdDedupeSortMs ?? 0)}.`,
    `sharded warm query phases: manifest ${ms(aggregate.avgShardedWarmManifestLoadMs ?? 0)}, prefilter ${ms(aggregate.avgShardedWarmShardPrefilterMs ?? 0)}, index ${ms(aggregate.avgShardedWarmIndexLoadMs ?? 0)}, candidate select ${ms(aggregate.avgShardedWarmCandidateSelectionMs ?? 0)}, tombstones ${ms(aggregate.avgShardedWarmTombstoneLoadMs ?? 0)}, row blocks ${ms(aggregate.avgShardedWarmRowBlockLoadMs ?? 0)}, vector blocks ${ms(aggregate.avgShardedWarmVectorBlockLoadMs ?? 0)}, rerank ${ms(aggregate.avgShardedWarmRerankMs ?? 0)}, dedupe/sort ${ms(aggregate.avgShardedWarmDedupeSortMs ?? 0)}.`,
    `exact baseline: pglite overlap@K ${aggregate.avgPgliteOverlapVsExactAtK.toFixed(4)}, sharded overlap@K ${aggregate.avgShardedOverlapVsExactAtK.toFixed(4)}, sharded top1 match ${aggregate.shardedTop1MatchVsExactRate.toFixed(4)}.`,
  ]
  if (dominantColdPhase) {
    stageFindings.push(
      `dominant sharded cold-query phase: ${dominantColdPhase.label} at ${ms(dominantColdPhase.value)}.`,
    )
  }
  if (dominantWarmPhase) {
    stageFindings.push(
      `dominant sharded warm-query phase: ${dominantWarmPhase.label} at ${ms(dominantWarmPhase.value)}.`,
    )
  }

  const benchmarkGaps: string[] = []
  if (
    aggregate.pgliteDumpSucceeded &&
    aggregate.pgliteDumpPeakRssDeltaMb <= 0 &&
    aggregate.pgliteDumpArrayBufferBytes !== null
  ) {
    benchmarkGaps.push(
      'pglite dump peak memory sampling is still under-reporting; a 0 MB peak with a huge dump buffer indicates the in-process sampler missed the blocking phase.',
    )
  }
  if (aggregate.buildMemoryDeltaMb < 0 || aggregate.sourceRowLoadMemoryDeltaMb < 0) {
    benchmarkGaps.push(
      'before/after process-memory deltas are distorted by GC or allocator reuse; stage conclusions should prioritize sampled peaks over end-state deltas.',
    )
  }

  const shardedImprovements: string[] = []
  if (aggregate.avgShardedColdPeakRssDeltaMb > 0) {
    shardedImprovements.push(
      `cold-query peak RSS is still ${mb(aggregate.avgShardedColdPeakRssDeltaMb)} on average; reduce first-touch cache materialization and avoid loading full shard payloads when only top candidates are needed.`,
    )
  }
  if (aggregate.avgShardedWarmMs > 20) {
    shardedImprovements.push(
      `warm-query latency is still ${ms(aggregate.avgShardedWarmMs)}; reduce rerank work, trim candidate fan-out, or narrow hot-path deserialization.`,
    )
  }
  if (
    (aggregate.avgShardedColdRowBlockLoadMs ?? 0) >
    (aggregate.avgShardedColdRerankMs ?? 0) &&
    (aggregate.avgShardedColdRowBlockLoadMs ?? 0) >
      (aggregate.avgShardedColdVectorBlockLoadMs ?? 0)
  ) {
    shardedImprovements.push(
      `cold-query IO is row-block dominated at ${ms(aggregate.avgShardedColdRowBlockLoadMs ?? 0)}; add offset-based row reads or a denser hot-row format before widening ANN work.`,
    )
  }
  if (
    (aggregate.avgShardedColdVectorBlockLoadMs ?? 0) >=
      (aggregate.avgShardedColdRowBlockLoadMs ?? 0) &&
    (aggregate.avgShardedColdVectorBlockLoadMs ?? 0) >
      (aggregate.avgShardedColdRerankMs ?? 0)
  ) {
    shardedImprovements.push(
      `cold-query IO is vector-block dominated at ${ms(aggregate.avgShardedColdVectorBlockLoadMs ?? 0)}; offset reads or smaller vector blocks should pay off before ANN tuning.`,
    )
  }
  if (
    (aggregate.avgShardedColdRerankMs ?? 0) >=
      (aggregate.avgShardedColdRowBlockLoadMs ?? 0) &&
    (aggregate.avgShardedColdRerankMs ?? 0) >=
      (aggregate.avgShardedColdVectorBlockLoadMs ?? 0) &&
    (aggregate.avgShardedColdRerankMs ?? 0) > 0
  ) {
    shardedImprovements.push(
      `cold-query compute is rerank dominated at ${ms(aggregate.avgShardedColdRerankMs ?? 0)}; optimize cosine loops or cut rerank candidates before more storage changes.`,
    )
  }
  if ((aggregate.shardedIncrementalUpdatePeakRssDeltaMb ?? 0) > 32) {
    shardedImprovements.push(
      `incremental update peak RSS is still ${mb(aggregate.shardedIncrementalUpdatePeakRssDeltaMb)}; reduce shard rewrite amplification for update-heavy vaults.`,
    )
  }
  if ((aggregate.shardedIncrementalDeletePeakRssDeltaMb ?? 0) > 32) {
    shardedImprovements.push(
      `incremental delete peak RSS is still ${mb(aggregate.shardedIncrementalDeletePeakRssDeltaMb)}; avoid rewriting oversized shards when only a few rows are removed.`,
    )
  }
  if (
    (aggregate.pgliteIncrementalUpdatePeakRssDeltaMb ?? 0) >
    (aggregate.shardedIncrementalUpdatePeakRssDeltaMb ?? 0)
  ) {
    shardedImprovements.push(
      `pglite incremental update peak RSS is higher at ${mb(aggregate.pgliteIncrementalUpdatePeakRssDeltaMb)}; keep write-path comparisons anchored on update/delete stages, not only full dump/save.`,
    )
  }
  if (
    aggregate.avgShardedOverlapVsExactAtK < 0.95 ||
    aggregate.shardedFullPathOrderMatchVsExactRate < 0.8
  ) {
    shardedImprovements.push(
      `exact baseline gap remains visible: sharded overlap@K=${aggregate.avgShardedOverlapVsExactAtK.toFixed(4)}, full-order match=${aggregate.shardedFullPathOrderMatchVsExactRate.toFixed(4)}; improve ANN recall before replacement defaulting.`,
    )
  }
  if (aggregate.shardCountEstimate <= 1) {
    shardedImprovements.push(
      'current sample does not stress multi-shard fan-out enough; use a larger row count before drawing final retrieval conclusions.',
    )
  }

  return {
    stageFindings,
    benchmarkGaps,
    shardedImprovements,
  }
}
