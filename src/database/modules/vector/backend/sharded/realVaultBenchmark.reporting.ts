type QueryKind = 'chat' | 'harder-stored' | 'self-control' | 'unknown'

type BenchmarkMetricLike = {
  query: string
  queryKind: QueryKind
  pgliteMs: number
  shardedColdMs: number
  shardedWarmMs: number
  pgliteOverlapVsExactAtK: number
  shardedOverlapVsExactAtK: number
}

type BenchmarkQueryLike = {
  text: string
  source?: 'chat-snapshot' | 'stored-perturbed' | 'stored-self'
}

const average = (values: number[]): number => {
  if (values.length === 0) {
    return 0
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export const classifyBenchmarkQuery = (query: BenchmarkQueryLike): QueryKind => {
  switch (query.source) {
    case 'chat-snapshot':
      return 'chat'
    case 'stored-perturbed':
      return 'harder-stored'
    case 'stored-self':
      return 'self-control'
    default:
      return 'unknown'
  }
}

export const groupMetricsByQueryKind = (
  metrics: BenchmarkMetricLike[],
): Record<QueryKind, BenchmarkMetricLike[]> => ({
  chat: metrics.filter((metric) => metric.queryKind === 'chat'),
  'harder-stored': metrics.filter(
    (metric) => metric.queryKind === 'harder-stored',
  ),
  'self-control': metrics.filter((metric) => metric.queryKind === 'self-control'),
  unknown: metrics.filter((metric) => metric.queryKind === 'unknown'),
})

export const aggregateMetrics = (metrics: BenchmarkMetricLike[]) => ({
  queryCount: metrics.length,
  avgPgliteMs: average(metrics.map((metric) => metric.pgliteMs)),
  avgShardedColdMs: average(metrics.map((metric) => metric.shardedColdMs)),
  avgShardedWarmMs: average(metrics.map((metric) => metric.shardedWarmMs)),
  avgPgliteOverlapVsExactAtK: average(
    metrics.map((metric) => metric.pgliteOverlapVsExactAtK),
  ),
  avgShardedOverlapVsExactAtK: average(
    metrics.map((metric) => metric.shardedOverlapVsExactAtK),
  ),
})

export type { BenchmarkMetricLike, QueryKind }
