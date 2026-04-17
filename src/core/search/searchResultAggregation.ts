import type {
  SuperSearchMatchType,
  SuperSearchResult,
  SuperSearchResultSource,
} from './hybridSearch'

export type AggregatedSearchSnippet = {
  line?: number
  startLine?: number
  endLine?: number
  page?: number
  snippet?: string
  source: SuperSearchResultSource
  similarity?: number
  rrfScore?: number
}

export type AggregatedContentSearchResult = {
  kind: 'content_group'
  path: string
  source: SuperSearchResultSource
  matchType?: SuperSearchMatchType
  score: number
  hitCount: number
  snippets: AggregatedSearchSnippet[]
}

type NonContentSearchResult = {
  kind: 'file' | 'dir'
  path: string
  source: SuperSearchResultSource
}

export type AggregatedSearchResult =
  | NonContentSearchResult
  | AggregatedContentSearchResult

const FILE_HIT_BONUS = 0.0001

const getNumericScore = (result: SuperSearchResult): number | undefined => {
  return result.rrfScore ?? result.similarity
}

const compareSnippetRows = (
  a: { result: SuperSearchResult; index: number },
  b: { result: SuperSearchResult; index: number },
): number => {
  const aScore = getNumericScore(a.result)
  const bScore = getNumericScore(b.result)

  if (aScore !== undefined || bScore !== undefined) {
    const normalizedAScore = aScore ?? Number.NEGATIVE_INFINITY
    const normalizedBScore = bScore ?? Number.NEGATIVE_INFINITY
    if (normalizedAScore !== normalizedBScore) {
      return normalizedBScore - normalizedAScore
    }
  }

  if (a.index !== b.index) {
    return a.index - b.index
  }

  const aLine = a.result.startLine ?? a.result.line ?? Number.MAX_SAFE_INTEGER
  const bLine = b.result.startLine ?? b.result.line ?? Number.MAX_SAFE_INTEGER
  if (aLine !== bLine) {
    return aLine - bLine
  }

  return a.result.path.localeCompare(b.result.path)
}

const getRangeBounds = (
  result: SuperSearchResult,
): { start: number; end: number } => {
  const start = result.startLine ?? result.line ?? Number.MAX_SAFE_INTEGER
  const end = result.endLine ?? result.line ?? start
  return { start, end }
}

const collapseOverlappingRows = (
  items: Array<{ result: SuperSearchResult; index: number }>,
): Array<{ result: SuperSearchResult; index: number }> => {
  const sortedByRange = [...items].sort((a, b) => {
    const aBounds = getRangeBounds(a.result)
    const bBounds = getRangeBounds(b.result)
    if (aBounds.start !== bBounds.start) {
      return aBounds.start - bBounds.start
    }
    if (aBounds.end !== bBounds.end) {
      return aBounds.end - bBounds.end
    }
    return a.index - b.index
  })

  const collapsed: Array<{ result: SuperSearchResult; index: number }> = []
  let currentCluster: Array<{ result: SuperSearchResult; index: number }> = []
  let currentClusterEnd = Number.NEGATIVE_INFINITY

  for (const item of sortedByRange) {
    const bounds = getRangeBounds(item.result)
    if (currentCluster.length === 0 || bounds.start > currentClusterEnd) {
      if (currentCluster.length > 0) {
        collapsed.push([...currentCluster].sort(compareSnippetRows)[0])
      }
      currentCluster = [item]
      currentClusterEnd = bounds.end
      continue
    }

    currentCluster.push(item)
    currentClusterEnd = Math.max(currentClusterEnd, bounds.end)
  }

  if (currentCluster.length > 0) {
    collapsed.push([...currentCluster].sort(compareSnippetRows)[0])
  }

  return collapsed
}

const deriveGroupSource = (
  items: Array<{ result: SuperSearchResult }>,
): SuperSearchResultSource => {
  const sources = new Set(items.map((item) => item.result.source))
  if (sources.has('hybrid') || (sources.has('keyword') && sources.has('rag'))) {
    return 'hybrid'
  }
  return items[0]?.result.source ?? 'keyword'
}

const deriveGroupMatchType = (
  items: Array<{ result: SuperSearchResult }>,
): SuperSearchMatchType | undefined => {
  if (items.some((item) => item.result.matchType === 'dual')) {
    return 'dual'
  }
  if (items.some((item) => item.result.matchType === 'content')) {
    return 'content'
  }
  return undefined
}

export function aggregateSearchResults({
  results,
  maxResults,
  maxSnippetsPerPath = 2,
}: {
  results: SuperSearchResult[]
  maxResults: number
  maxSnippetsPerPath?: number
}): AggregatedSearchResult[] {
  const passthrough: Array<{
    index: number
    result: NonContentSearchResult
  }> = []
  const grouped = new Map<
    string,
    Array<{ result: SuperSearchResult; index: number }>
  >()

  results.forEach((result, index) => {
    if (result.kind === 'file' || result.kind === 'dir') {
      passthrough.push({
        index,
        result: {
          kind: result.kind,
          path: result.path,
          source: result.source,
        },
      })
      return
    }

    const existing = grouped.get(result.path)
    if (existing) {
      existing.push({ result, index })
      return
    }
    grouped.set(result.path, [{ result, index }])
  })

  const contentGroups = [...grouped.entries()].map(([path, items]) => {
    const collapsedItems = collapseOverlappingRows(items)
    const sortedItems = [...collapsedItems].sort(compareSnippetRows)
    const topItems = sortedItems.slice(0, maxSnippetsPerPath)
    const firstIndex = Math.min(...items.map((item) => item.index))
    const bestScore = sortedItems[0]
      ? (getNumericScore(sortedItems[0].result) ?? 0)
      : 0
    const bonus =
      Math.min(Math.max(collapsedItems.length - 1, 0), 2) * FILE_HIT_BONUS

    return {
      firstIndex,
      group: {
        kind: 'content_group' as const,
        path,
        source: deriveGroupSource(items),
        matchType: deriveGroupMatchType(items),
        score: bestScore + bonus,
        hitCount: collapsedItems.length,
        snippets: topItems.map((item) => ({
          line: item.result.line,
          startLine: item.result.startLine,
          endLine: item.result.endLine,
          page: item.result.page,
          snippet: item.result.snippet,
          source: item.result.source,
          similarity: item.result.similarity,
          rrfScore: item.result.rrfScore,
        })),
      },
    }
  })

  if (passthrough.length === 0) {
    return contentGroups
      .sort((a, b) => {
        if (a.group.score !== b.group.score) {
          return b.group.score - a.group.score
        }
        if (a.firstIndex !== b.firstIndex) {
          return a.firstIndex - b.firstIndex
        }
        return a.group.path.localeCompare(b.group.path)
      })
      .slice(0, maxResults)
      .map((entry) => entry.group)
  }

  return [
    ...passthrough.map((entry) => ({
      index: entry.index,
      item: entry.result as AggregatedSearchResult,
    })),
    ...contentGroups.map((entry) => ({
      index: entry.firstIndex,
      item: entry.group as AggregatedSearchResult,
    })),
  ]
    .sort((a, b) => {
      if (a.index !== b.index) {
        return a.index - b.index
      }
      return a.item.path.localeCompare(b.item.path)
    })
    .slice(0, maxResults)
    .map((entry) => entry.item)
}
