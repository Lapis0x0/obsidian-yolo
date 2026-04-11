import type { SuperSearchResult } from './hybridSearch'
import { aggregateSearchResults } from './searchResultAggregation'

describe('aggregateSearchResults', () => {
  const hybridHit = (
    path: string,
    startLine: number,
    endLine: number,
    rrfScore: number,
    matchType: 'content' | 'dual' = 'content',
  ): SuperSearchResult => ({
    kind: 'content',
    path,
    line: startLine,
    startLine,
    endLine,
    snippet: `${path}:${startLine}-${endLine}`,
    source: 'hybrid',
    rrfScore,
    matchType,
  })

  it('groups multiple content hits from the same file and keeps top snippets', () => {
    const results = aggregateSearchResults({
      results: [
        hybridHit('a.md', 1, 2, 0.02, 'dual'),
        hybridHit('b.md', 4, 6, 0.018),
        hybridHit('a.md', 10, 12, 0.017),
        hybridHit('a.md', 20, 22, 0.015),
      ],
      maxResults: 10,
    })

    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({
      kind: 'content_group',
      path: 'a.md',
      source: 'hybrid',
      matchType: 'dual',
      hitCount: 3,
    })

    if (results[0].kind !== 'content_group') {
      throw new Error('expected content_group')
    }

    expect(results[0].snippets).toHaveLength(2)
    expect(results[0].snippets).toMatchObject([
      { startLine: 1, endLine: 2, rrfScore: 0.02 },
      { startLine: 10, endLine: 12, rrfScore: 0.017 },
    ])
  })

  it('preserves file results and mixed ordering for non-content keyword scopes', () => {
    const results = aggregateSearchResults({
      results: [
        { kind: 'file', path: 'docs/a.md', source: 'keyword' },
        hybridHit('docs/a.md', 8, 10, 0.02),
        { kind: 'dir', path: 'docs/sub', source: 'keyword' },
      ],
      maxResults: 10,
    })

    expect(results).toMatchObject([
      { kind: 'file', path: 'docs/a.md', source: 'keyword' },
      {
        kind: 'content_group',
        path: 'docs/a.md',
        source: 'hybrid',
        hitCount: 1,
      },
      { kind: 'dir', path: 'docs/sub', source: 'keyword' },
    ])
  })

  it('collapses overlapping hits from the same file before selecting snippets', () => {
    const results = aggregateSearchResults({
      results: [
        hybridHit('a.md', 1, 1, 0.02),
        hybridHit('a.md', 1, 3, 0.019),
        hybridHit('a.md', 8, 10, 0.018),
      ],
      maxResults: 10,
    })

    expect(results).toHaveLength(1)
    if (results[0].kind !== 'content_group') {
      throw new Error('expected content_group')
    }

    expect(results[0]).toMatchObject({
      path: 'a.md',
      hitCount: 2,
      snippets: [
        { startLine: 1, endLine: 1 },
        { startLine: 8, endLine: 10 },
      ],
    })
  })
})
