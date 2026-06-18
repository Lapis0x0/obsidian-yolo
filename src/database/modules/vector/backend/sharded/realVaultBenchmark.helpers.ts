type BenchmarkQuery = {
  text: string
  vector?: number[]
  source?: 'chat-snapshot' | 'stored-perturbed' | 'stored-self'
}

type SearchHit = {
  path: string
  content_hash: string | null
}

type ExactRow = {
  path: string
  content: string
  content_hash: string | null
  embedding: number[] | null
}

type ExactTopKInput = {
  queryVector: number[]
  rows: ExactRow[]
  minSimilarity: number
  limit: number
  model: string
  dimension: number
}

type ExactResultRow = {
  id: number
  path: string
  mtime: number
  content: string
  content_hash: string | null
  model: string
  dimension: number
  metadata: Record<string, unknown>
  similarity: number
}

type QueryComparisons = {
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
}

const resultKey = (hit: SearchHit): string => `${hit.path}::${hit.content_hash ?? ''}`

const computeOverlapAtK = (left: SearchHit[], right: SearchHit[]): number => {
  if (left.length === 0 || right.length === 0) {
    return 0
  }
  const rightKeys = new Set(right.map(resultKey))
  const overlapCount = left.filter((hit) => rightKeys.has(resultKey(hit))).length
  return overlapCount / Math.min(left.length, right.length)
}

const computePathOverlapAtK = (left: SearchHit[], right: SearchHit[]): number => {
  if (left.length === 0 || right.length === 0) {
    return 0
  }
  const rightPaths = new Set(right.map((hit) => hit.path))
  const overlapCount = left.filter((hit) => rightPaths.has(hit.path)).length
  return overlapCount / Math.min(left.length, right.length)
}

const computeFullPathOrderMatch = (
  leftPaths: string[],
  rightPaths: string[],
): boolean => {
  if (leftPaths.length !== rightPaths.length) {
    return false
  }
  return leftPaths.every((path, index) => path === rightPaths[index])
}

const computeOrderedPathPrefixMatchAtK = (
  leftPaths: string[],
  rightPaths: string[],
): number => {
  if (leftPaths.length === 0 || rightPaths.length === 0) {
    return 0
  }
  const limit = Math.min(leftPaths.length, rightPaths.length)
  let matched = 0
  for (let index = 0; index < limit; index += 1) {
    if (leftPaths[index] === rightPaths[index]) {
      matched += 1
    }
  }
  return matched / limit
}

const computeAverageRankDisplacement = (
  leftPaths: string[],
  rightPaths: string[],
): number => {
  if (leftPaths.length === 0 || rightPaths.length === 0) {
    return 0
  }
  const rightRank = new Map<string, number>()
  rightPaths.forEach((path, index) => {
    if (!rightRank.has(path)) {
      rightRank.set(path, index)
    }
  })
  const shared = leftPaths
    .map((path, index) => {
      const otherIndex = rightRank.get(path)
      if (otherIndex === undefined) {
        return null
      }
      return Math.abs(index - otherIndex)
    })
    .filter((value): value is number => value !== null)
  if (shared.length === 0) {
    return Number(Math.min(leftPaths.length, rightPaths.length))
  }
  return Number(
    (shared.reduce((sum, value) => sum + value, 0) / shared.length).toFixed(4),
  )
}

const cosineSimilarity = (a: number[], b: number[]): number => {
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

const groupPathKey = (path: string): string => {
  const normalized = path.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length <= 1) {
    return normalized
  }
  return parts.slice(0, parts.length - 1).join('/')
}

const normalizeQueryText = (content: string): string =>
  content.replace(/\s+/g, ' ').trim()

const stripStructuredPrefix = (content: string): string => {
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  let startIndex = 0
  while (startIndex < lines.length) {
    const line = lines[startIndex] ?? ''
    if (
      /^[a-z0-9_-]{1,32}:\s/i.test(line) ||
      line.startsWith('---') ||
      line.startsWith('```') ||
      line.startsWith('#')
    ) {
      startIndex += 1
      continue
    }
    break
  }
  return lines.slice(startIndex).join(' ')
}

const middleWindow = (content: string, maxLength = 120): string => {
  const normalized = normalizeQueryText(content)
  if (normalized.length <= maxLength) {
    return normalized
  }
  const start = Math.max(0, Math.floor((normalized.length - maxLength) / 2))
  return normalized.slice(start, start + maxLength).trim()
}

const perturbQueryText = (content: string): string => {
  const stripped = stripStructuredPrefix(content)
  const normalized = normalizeQueryText(stripped || content)
  if (normalized.length <= 120) {
    return normalized
  }
  const middle = middleWindow(normalized, 120)
  return middle || normalized.slice(0, 120).trim()
}

export const buildFallbackQueriesFromRows = (
  rows: Array<{
    path: string
    content: string
    embedding: number[] | null
  }>,
  queryCount: number,
): BenchmarkQuery[] => {
  const grouped = new Map<string, typeof rows>()
  rows.forEach((row) => {
    if (!row.embedding || row.embedding.length === 0) {
      return
    }
    const key = groupPathKey(row.path)
    const bucket = grouped.get(key)
    if (bucket) {
      bucket.push(row)
    } else {
      grouped.set(key, [row])
    }
  })

  const groups = Array.from(grouped.values()).sort((left, right) => {
    const leftPath = left[0]?.path ?? ''
    const rightPath = right[0]?.path ?? ''
    return leftPath.localeCompare(rightPath)
  })

  const queries: BenchmarkQuery[] = []
  let groupIndex = 0
  while (queries.length < queryCount && groups.length > 0) {
    const group = groups[groupIndex % groups.length]
    const row = group.shift()
    if (row?.embedding?.length) {
      const normalizedText = row.content.replace(/\s+/g, ' ').trim().slice(0, 120)
      if (normalizedText) {
        queries.push({
          text: normalizedText,
          vector: row.embedding,
          source: 'stored-self',
        })
      }
    }
    if (group.length === 0) {
      groups.splice(groupIndex % groups.length, 1)
      if (groups.length === 0) {
        break
      }
      continue
    }
    groupIndex += 1
  }

  return queries
}

export const buildHarderStoredVectorQueries = (
  rows: Array<{
    path: string
    content: string
    embedding: number[] | null
  }>,
  queryCount: number,
): BenchmarkQuery[] => {
  const groupedByPath = new Map<string, typeof rows>()
  rows.forEach((row) => {
    if (!row.embedding || row.embedding.length === 0) {
      return
    }
    const bucket = groupedByPath.get(row.path)
    if (bucket) {
      bucket.push(row)
    } else {
      groupedByPath.set(row.path, [row])
    }
  })

  const groupedByDirectory = new Map<
    string,
    Array<{
      path: string
      content: string
      embedding: number[] | null
    }>
  >()
  Array.from(groupedByPath.values()).forEach((group) => {
    group.forEach((row) => {
      const bucket = groupedByDirectory.get(groupPathKey(row.path))
      if (bucket) {
        bucket.push(row)
      } else {
        groupedByDirectory.set(groupPathKey(row.path), [row])
      }
    })
  })

  const orderedGroups = Array.from(groupedByDirectory.entries()).sort(
    ([left], [right]) => left.localeCompare(right),
  )

  const queries: BenchmarkQuery[] = []
  const seenTexts = new Set<string>()
  for (const [, group] of orderedGroups) {
    if (queries.length >= queryCount) {
      break
    }
    const primary = group[0]
    if (!primary?.embedding?.length) {
      continue
    }
    const alternate = group.find((row, index) => index > 0) ?? null
    const baseContent = alternate?.content ?? primary.content
    const text = perturbQueryText(baseContent)
    if (!text || seenTexts.has(text)) {
      continue
    }
    seenTexts.add(text)
    queries.push({
      text,
      vector: primary.embedding,
      source: 'stored-perturbed',
    })
  }

  if (queries.length >= queryCount) {
    return queries.slice(0, queryCount)
  }

  const fallback = buildFallbackQueriesFromRows(rows, queryCount * 2)
  fallback.forEach((query) => {
    if (queries.length >= queryCount) {
      return
    }
    const text = perturbQueryText(query.text)
    if (!text || seenTexts.has(text)) {
      return
    }
    seenTexts.add(text)
    queries.push({
      text,
      vector: query.vector,
      source: 'stored-self',
    })
  })

  return queries.slice(0, queryCount)
}

export const computeExactTopK = (input: ExactTopKInput): ExactResultRow[] => {
  return input.rows
    .map((row, index) => {
      if (!row.embedding || row.embedding.length === 0) {
        return null
      }
      const similarity = cosineSimilarity(input.queryVector, row.embedding)
      if (similarity <= input.minSimilarity) {
        return null
      }
      return {
        id: index,
        path: row.path,
        mtime: 0,
        content: row.content,
        content_hash: row.content_hash,
        model: input.model,
        dimension: input.dimension,
        metadata: {},
        similarity,
      }
    })
    .filter((row): row is ExactResultRow => row !== null)
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, input.limit)
}

export const computeQueryComparisons = (input: {
  exactResults: SearchHit[]
  pgliteResults: SearchHit[]
  shardedResults: SearchHit[]
}): QueryComparisons => {
  const exactPaths = input.exactResults.map((row) => row.path)
  const pglitePaths = input.pgliteResults.map((row) => row.path)
  const shardedPaths = input.shardedResults.map((row) => row.path)

  return {
    pgliteOverlapVsExactAtK: computeOverlapAtK(
      input.pgliteResults,
      input.exactResults,
    ),
    pglitePathOverlapVsExactAtK: computePathOverlapAtK(
      input.pgliteResults,
      input.exactResults,
    ),
    pgliteOrderedPathPrefixMatchVsExactAtK: computeOrderedPathPrefixMatchAtK(
      pglitePaths,
      exactPaths,
    ),
    pgliteAvgRankDisplacementVsExact: computeAverageRankDisplacement(
      pglitePaths,
      exactPaths,
    ),
    pgliteTop1MatchVsExact:
      (pglitePaths[0] ?? null) === (exactPaths[0] ?? null),
    pgliteFullPathOrderMatchVsExact: computeFullPathOrderMatch(
      pglitePaths,
      exactPaths,
    ),
    shardedOverlapVsExactAtK: computeOverlapAtK(
      input.shardedResults,
      input.exactResults,
    ),
    shardedPathOverlapVsExactAtK: computePathOverlapAtK(
      input.shardedResults,
      input.exactResults,
    ),
    shardedOrderedPathPrefixMatchVsExactAtK: computeOrderedPathPrefixMatchAtK(
      shardedPaths,
      exactPaths,
    ),
    shardedAvgRankDisplacementVsExact: computeAverageRankDisplacement(
      shardedPaths,
      exactPaths,
    ),
    shardedTop1MatchVsExact:
      (shardedPaths[0] ?? null) === (exactPaths[0] ?? null),
    shardedFullPathOrderMatchVsExact: computeFullPathOrderMatch(
      shardedPaths,
      exactPaths,
    ),
    shardedOverlapVsPgliteAtK: computeOverlapAtK(
      input.shardedResults,
      input.pgliteResults,
    ),
    shardedPathOverlapVsPgliteAtK: computePathOverlapAtK(
      input.shardedResults,
      input.pgliteResults,
    ),
    shardedOrderedPathPrefixMatchVsPgliteAtK: computeOrderedPathPrefixMatchAtK(
      shardedPaths,
      pglitePaths,
    ),
    shardedAvgRankDisplacementVsPglite: computeAverageRankDisplacement(
      shardedPaths,
      pglitePaths,
    ),
    shardedTop1MatchVsPglite:
      (shardedPaths[0] ?? null) === (pglitePaths[0] ?? null),
    shardedFullPathOrderMatchVsPglite: computeFullPathOrderMatch(
      shardedPaths,
      pglitePaths,
    ),
  }
}

export type {
  BenchmarkQuery,
  ExactResultRow,
  ExactRow,
  QueryComparisons,
  SearchHit,
}
