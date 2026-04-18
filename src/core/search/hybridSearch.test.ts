import {
  type SuperSearchResult,
  fuseRrfHybrid,
  superSearchDedupKey,
} from './hybridSearch'

describe('hybridSearch RRF', () => {
  const kw = (path: string, line: number): SuperSearchResult => ({
    kind: 'content',
    path,
    line,
    startLine: line,
    endLine: line,
    snippet: 'k',
    source: 'keyword',
  })

  const rag = (
    path: string,
    startLine: number,
    endLine: number,
    similarity: number,
  ): SuperSearchResult => ({
    kind: 'content',
    path,
    line: startLine,
    startLine,
    endLine,
    snippet: 'r',
    similarity,
    source: 'rag',
  })

  it('merges duplicate keys and boosts dual hits', () => {
    const keywordResults = [kw('a.md', 1), kw('b.md', 2)]
    const ragResults = [rag('a.md', 1, 1, 0.9), rag('c.md', 5, 6, 0.8)]
    const fused = fuseRrfHybrid({
      keywordResults,
      ragResults,
      maxResults: 10,
    })
    expect(fused[0].path).toBe('a.md')
    expect(fused[0].source).toBe('hybrid')
    expect(fused[0].matchType).toBe('content')
    expect(fused[0].rrfScore).toBeGreaterThan(0)
  })

  it('keeps path hits but ranks them after all content hits', () => {
    const pathResults: SuperSearchResult[] = [
      {
        kind: 'file',
        path: 'z-target.md',
        source: 'keyword',
      },
    ]
    const keywordResults = [kw('b.md', 2)]
    const ragResults = [rag('c.md', 5, 6, 0.8)]

    const fused = fuseRrfHybrid({
      pathResults,
      keywordResults,
      ragResults,
      maxResults: 10,
    })

    expect(fused).toHaveLength(2)
    expect(fused.every((result) => result.kind === 'content')).toBe(true)
    expect(fused.every((result) => result.matchType === 'content')).toBe(true)
    expect(fused.map((result) => result.path).sort()).toEqual(['b.md', 'c.md'])
  })

  it('marks path and content hits on the same file as dual', () => {
    const pathResults: SuperSearchResult[] = [
      {
        kind: 'file',
        path: 'a.md',
        source: 'keyword',
      },
    ]
    const keywordResults = [kw('a.md', 4)]

    const fused = fuseRrfHybrid({
      pathResults,
      keywordResults,
      ragResults: [],
      maxResults: 10,
    })

    expect(fused[0]).toMatchObject({
      path: 'a.md',
      kind: 'content',
      matchType: 'dual',
      source: 'hybrid',
      line: 4,
    })
  })

  it('keeps multiple content hits from the same file when path also matches', () => {
    const pathResults: SuperSearchResult[] = [
      {
        kind: 'file',
        path: 'a.md',
        source: 'keyword',
      },
    ]
    const keywordResults = [kw('a.md', 4), kw('a.md', 12)]

    const fused = fuseRrfHybrid({
      pathResults,
      keywordResults,
      ragResults: [],
      maxResults: 10,
    })

    expect(fused).toHaveLength(2)
    expect(fused).toMatchObject([
      {
        path: 'a.md',
        kind: 'content',
        line: 4,
        matchType: 'dual',
      },
      {
        path: 'a.md',
        kind: 'content',
        line: 12,
        matchType: 'dual',
      },
    ])
  })

  it('does not return path-only hits when there is no content hit', () => {
    const pathResults: SuperSearchResult[] = [
      {
        kind: 'file',
        path: 'a.md',
        source: 'keyword',
      },
    ]

    const fused = fuseRrfHybrid({
      pathResults,
      keywordResults: [],
      ragResults: [],
      maxResults: 10,
    })

    expect(fused).toEqual([])
  })

  it('dedup key matches content line range', () => {
    const a: SuperSearchResult = {
      kind: 'content',
      path: 'x.md',
      line: 3,
      startLine: 3,
      endLine: 5,
      snippet: '',
      source: 'rag',
    }
    const b: SuperSearchResult = {
      kind: 'content',
      path: 'x.md',
      line: 3,
      startLine: 3,
      endLine: 5,
      snippet: '',
      source: 'keyword',
    }
    expect(superSearchDedupKey(a)).toBe(superSearchDedupKey(b))
  })
})
