/**
 * Hybrid search: reciprocal rank fusion (RRF) for keyword + RAG result lists.
 */

export type SuperSearchResultSource = 'keyword' | 'rag' | 'hybrid'
export type SuperSearchMatchType = 'dual' | 'content' | 'path'

export type SuperSearchResult = {
  kind: 'file' | 'dir' | 'content'
  path: string
  /** Primary line for display (e.g. keyword hit line) */
  line?: number
  startLine?: number
  endLine?: number
  snippet?: string
  source: SuperSearchResultSource
  matchType?: SuperSearchMatchType
  similarity?: number
  rrfScore?: number
}

export const RRF_K_DEFAULT = 60

/** Stable dedup key for RRF: content uses path + line range; file/dir uses kind + path. */
export function superSearchDedupKey(result: SuperSearchResult): string {
  if (result.kind === 'content') {
    const start = result.startLine ?? result.line ?? 0
    const end = result.endLine ?? result.line ?? start
    return `content:${result.path}:${start}:${end}`
  }
  return `${result.kind}:${result.path}`
}

function firstRankByKey(results: SuperSearchResult[]): Map<string, number> {
  const map = new Map<string, number>()
  results.forEach((r, index) => {
    const key = superSearchDedupKey(r)
    if (!map.has(key)) {
      map.set(key, index + 1)
    }
  })
  return map
}

function mergeHybridRow(
  keyword: SuperSearchResult | undefined,
  rag: SuperSearchResult | undefined,
  rrfScore: number,
): SuperSearchResult {
  const base = rag ?? keyword
  if (!base) {
    throw new Error('mergeHybridRow: at least one side required')
  }
  return {
    kind: base.kind,
    path: base.path,
    line: keyword?.line ?? rag?.line,
    startLine: rag?.startLine ?? keyword?.startLine,
    endLine: rag?.endLine ?? keyword?.endLine,
    snippet: rag?.snippet ?? keyword?.snippet ?? base.snippet,
    similarity: rag?.similarity,
    source: 'hybrid',
    rrfScore,
  }
}

function pathRankByPath(results: SuperSearchResult[]): Map<string, number> {
  const map = new Map<string, number>()
  results.forEach((result, index) => {
    if (!map.has(result.path)) {
      map.set(result.path, index + 1)
    }
  })
  return map
}

function resultScore(result: SuperSearchResult): number {
  return result.rrfScore ?? result.similarity ?? 0
}

/**
 * Fuse keyword and RAG ranked lists with RRF (1-based ranks, k default 60).
 */
export function fuseRrfHybrid({
  pathResults = [],
  keywordResults,
  ragResults,
  k = RRF_K_DEFAULT,
  maxResults,
}: {
  pathResults?: SuperSearchResult[]
  keywordResults: SuperSearchResult[]
  ragResults: SuperSearchResult[]
  k?: number
  maxResults: number
}): SuperSearchResult[] {
  const keywordRanks = firstRankByKey(keywordResults)
  const ragRanks = firstRankByKey(ragResults)
  const keys = new Set<string>([...keywordRanks.keys(), ...ragRanks.keys()])
  const pathRanks = pathRankByPath(pathResults)

  const scored: Array<{ score: number; merged: SuperSearchResult }> = []

  for (const key of keys) {
    let score = 0
    const kr = keywordRanks.get(key)
    const rr = ragRanks.get(key)
    if (kr !== undefined) {
      score += 1 / (k + kr)
    }
    if (rr !== undefined) {
      score += 1 / (k + rr)
    }
    const kwItem = keywordResults.find((r) => superSearchDedupKey(r) === key)
    const ragItem = ragResults.find((r) => superSearchDedupKey(r) === key)
    const merged = mergeHybridRow(kwItem, ragItem, score)
    scored.push({
      score,
      merged: {
        ...merged,
        matchType: pathRanks.has(merged.path) ? 'dual' : 'content',
      },
    })
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score
    }
    const aPathRank = pathRanks.get(a.merged.path) ?? Number.MAX_SAFE_INTEGER
    const bPathRank = pathRanks.get(b.merged.path) ?? Number.MAX_SAFE_INTEGER
    if (aPathRank !== bPathRank) {
      return aPathRank - bPathRank
    }
    const aSimilarity = a.merged.similarity ?? 0
    const bSimilarity = b.merged.similarity ?? 0
    if (aSimilarity !== bSimilarity) {
      return bSimilarity - aSimilarity
    }
    return a.merged.path.localeCompare(b.merged.path)
  })

  return scored.slice(0, maxResults).map((entry) => entry.merged)
}
