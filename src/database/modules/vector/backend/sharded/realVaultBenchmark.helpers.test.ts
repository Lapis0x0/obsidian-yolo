import {
  buildFallbackQueriesFromRows,
  buildHarderStoredVectorQueries,
  computeExactTopK,
  computeQueryComparisons,
} from './realVaultBenchmark.helpers'

describe('realVaultBenchmark helpers', () => {
  it('builds fallback queries from diverse file paths instead of only the first rows', () => {
    const queries = buildFallbackQueriesFromRows(
      [
        {
          path: 'alpha/a-1.md',
          content: 'alpha first chunk',
          embedding: [1, 0, 0],
        },
        {
          path: 'alpha/a-2.md',
          content: 'alpha second chunk',
          embedding: [0.9, 0.1, 0],
        },
        {
          path: 'beta/b-1.md',
          content: 'beta first chunk',
          embedding: [0, 1, 0],
        },
        {
          path: 'beta/b-2.md',
          content: 'beta second chunk',
          embedding: [0, 0.9, 0.1],
        },
        {
          path: 'gamma/c-1.md',
          content: 'gamma first chunk',
          embedding: [0, 0, 1],
        },
      ],
      3,
    )

    expect(queries).toHaveLength(3)
    expect(queries.map((query) => query.text)).toEqual([
      'alpha first chunk',
      'beta first chunk',
      'gamma first chunk',
    ])
  })

  it('computes exact top-k results and comparison metrics against exact baseline', () => {
    const exact = computeExactTopK({
      queryVector: [1, 0],
      rows: [
        {
          path: 'docs/a.md',
          content: 'alpha',
          content_hash: 'h1',
          embedding: [1, 0],
        },
        {
          path: 'docs/b.md',
          content: 'beta',
          content_hash: 'h2',
          embedding: [0.8, 0.2],
        },
        {
          path: 'docs/c.md',
          content: 'gamma',
          content_hash: 'h3',
          embedding: [0, 1],
        },
      ],
      minSimilarity: -1,
      limit: 2,
      model: 'test-model',
      dimension: 2,
    })

    expect(exact.map((row) => row.path)).toEqual(['docs/a.md', 'docs/b.md'])

    const comparisons = computeQueryComparisons({
      exactResults: exact.map((row) => ({
        path: row.path,
        content_hash: row.content_hash,
      })),
      pgliteResults: [
        { path: 'docs/a.md', content_hash: 'h1' },
        { path: 'docs/c.md', content_hash: 'h3' },
      ],
      shardedResults: [
        { path: 'docs/a.md', content_hash: 'h1' },
        { path: 'docs/b.md', content_hash: 'h2' },
      ],
    })

    expect(comparisons.pgliteOverlapVsExactAtK).toBe(0.5)
    expect(comparisons.shardedOverlapVsExactAtK).toBe(1)
    expect(comparisons.pgliteTop1MatchVsExact).toBe(true)
    expect(comparisons.shardedTop1MatchVsExact).toBe(true)
    expect(comparisons.shardedFullPathOrderMatchVsExact).toBe(true)
    expect(comparisons.pgliteAvgRankDisplacementVsExact).toBe(0)
  })

  it('builds harder stored-vector queries by perturbing text instead of reusing exact chunk content', () => {
    const queries = buildHarderStoredVectorQueries(
      [
        {
          path: 'alpha/doc-1.md',
          content:
            'title: alpha project weekly update\nowner: team-a\nstatus: green\nThe battery pack validation finished this week with two deviations pending review.',
          embedding: [1, 0, 0],
        },
        {
          path: 'alpha/doc-1.md',
          content:
            'Follow-up actions: review the two deviations, schedule supplier call, and update the issue tracker before Friday.',
          embedding: [0.95, 0.05, 0],
        },
        {
          path: 'beta/doc-2.md',
          content:
            'Meeting notes for grid dispatch. The outage drill focused on relay coordination and emergency rollback steps.',
          embedding: [0, 1, 0],
        },
        {
          path: 'gamma/doc-3.md',
          content:
            'Computational chemistry summary. Optimized geometry converged after 36 steps and HOMO-LUMO gap remained stable.',
          embedding: [0, 0, 1],
        },
      ],
      3,
    )

    expect(queries).toHaveLength(3)
    expect(queries.every((query) => query.vector?.length === 3)).toBe(true)
    expect(
      queries.some(
        (query) =>
          (query.text.includes('validation finished this week') ||
            query.text.includes('Follow-up actions: review the two deviations')) &&
          !query.text.includes('title: alpha project weekly update'),
      ),
    ).toBe(true)
    expect(
      queries.some(
        (query) =>
          query.text.includes('Meeting notes for grid dispatch') ||
          query.text.includes('Optimized geometry converged after 36 steps'),
      ),
    ).toBe(true)
  })

  it('keeps source labels on generated query sets', () => {
    const fallback = buildFallbackQueriesFromRows(
      [
        {
          path: 'alpha/a.md',
          content: 'alpha chunk text',
          embedding: [1, 0, 0],
        },
      ],
      1,
    )
    const harder = buildHarderStoredVectorQueries(
      [
        {
          path: 'alpha/a.md',
          content: 'title: alpha\nalpha chunk text',
          embedding: [1, 0, 0],
        },
        {
          path: 'alpha/a.md',
          content: 'follow-up alpha chunk text',
          embedding: [0.9, 0.1, 0],
        },
      ],
      1,
    )

    expect(fallback[0]?.source).toBe('stored-self')
    expect(harder[0]?.source).toBe('stored-perturbed')
  })
})
