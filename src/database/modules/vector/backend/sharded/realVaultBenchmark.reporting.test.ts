import {
  aggregateMetrics,
  classifyBenchmarkQuery,
  groupMetricsByQueryKind,
  type BenchmarkMetricLike,
} from './realVaultBenchmark.reporting'

describe('realVaultBenchmark reporting', () => {
  it('classifies benchmark query kinds', () => {
    expect(
      classifyBenchmarkQuery({
        text: '昨天那个跳闸的怎么处理',
        source: 'chat-snapshot',
      }),
    ).toBe('chat')
    expect(
      classifyBenchmarkQuery({
        text: 'validation finished this week with two deviations pending review',
        source: 'stored-perturbed',
      }),
    ).toBe('harder-stored')
    expect(
      classifyBenchmarkQuery({
        text: 'alpha first chunk',
        source: 'stored-self',
      }),
    ).toBe('self-control')
    expect(
      classifyBenchmarkQuery({
        text: 'unlabeled query',
      }),
    ).toBe('unknown')
  })

  it('groups and aggregates metrics by query kind', () => {
    const metrics: BenchmarkMetricLike[] = [
      {
        query: 'chat q1',
        queryKind: 'chat',
        pgliteMs: 100,
        shardedColdMs: 10,
        shardedWarmMs: 5,
        pgliteOverlapVsExactAtK: 0.5,
        shardedOverlapVsExactAtK: 1,
      },
      {
        query: 'stored q1',
        queryKind: 'harder-stored',
        pgliteMs: 200,
        shardedColdMs: 20,
        shardedWarmMs: 8,
        pgliteOverlapVsExactAtK: 0.4,
        shardedOverlapVsExactAtK: 0.9,
      },
      {
        query: 'stored q2',
        queryKind: 'harder-stored',
        pgliteMs: 300,
        shardedColdMs: 30,
        shardedWarmMs: 10,
        pgliteOverlapVsExactAtK: 0.6,
        shardedOverlapVsExactAtK: 0.8,
      },
    ]

    const grouped = groupMetricsByQueryKind(metrics)
    expect(grouped.chat).toHaveLength(1)
    expect(grouped['harder-stored']).toHaveLength(2)

    const aggregate = aggregateMetrics(grouped['harder-stored'])
    expect(aggregate.queryCount).toBe(2)
    expect(aggregate.avgPgliteMs).toBe(250)
    expect(aggregate.avgShardedColdMs).toBe(25)
    expect(aggregate.avgPgliteOverlapVsExactAtK).toBe(0.5)
    expect(aggregate.avgShardedOverlapVsExactAtK).toBeCloseTo(0.85, 6)
  })
})
