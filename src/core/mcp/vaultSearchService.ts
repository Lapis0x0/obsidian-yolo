import { App, TFile, TFolder } from 'obsidian'

import type { YoloSettings } from '../../settings/schema/setting.types'
import { isWithinYoloUserDataRoot } from '../paths/yoloPaths'
import type { RAGEngine } from '../rag/ragEngine'
import { type SuperSearchResult, fuseRrfHybrid } from '../search/hybridSearch'
import {
  type AggregatedSearchResult,
  aggregateSearchResults,
} from '../search/searchResultAggregation'

import { validateVaultPath } from './vaultFileOps'

/**
 * Keyword / semantic (RAG) / hybrid vault retrieval, orchestrated for the
 * external `vault_search` MCP tool (see `desktopLocalMcpServer.ts`).
 *
 * This logic used to live inside the internal agent's `fs_search` tool. That
 * tool was retired in favor of the agent's sandboxed bash tool (YOLO-45),
 * which does its own read-only search (grep/find/rg) directly over the
 * `/vault` mount. Two callers remain: the external `vault_search` MCP tool
 * (JSON via `runVaultSearch`) and the bash tool's custom `search` command
 * (structured via `runVaultSearchStructured`, see
 * `src/core/agent/bash/vaultBashSearch.ts`) — semantic retrieval returns to
 * the agent as a bash command rather than a separate tool schema.
 */

const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024
const MAX_RAG_SNIPPET_CHARS = 500
const RAG_FETCH_LIMIT_MAX = 300

export type VaultSearchScope = 'files' | 'dirs' | 'content' | 'all'
export type VaultSearchMode = 'keyword' | 'rag' | 'hybrid'

export type VaultSearchOutcome =
  | { status: 'success'; text: string }
  | { status: 'aborted' }
  | { status: 'error'; error: string }

export type VaultSearchStructuredOutcome =
  | {
      status: 'success'
      requestedMode: VaultSearchMode
      effectiveMode: VaultSearchMode
      /** Set when hybrid degraded to keyword because RAG is unavailable. */
      fallbackReason?: string
      scope: VaultSearchScope
      query: string
      path: string
      results: AggregatedSearchResult[]
    }
  | { status: 'aborted' }
  | { status: 'error'; error: string }

type LegacySearchItem =
  | { kind: 'file'; path: string }
  | { kind: 'dir'; path: string }
  | { kind: 'content_match'; path: string; line: number; snippet: string }

/**
 * Scope for vault_search. `vault` = entire vault, `folder` = recursive
 * subtree, `file` = a single file (RAG restricts to that file's chunks;
 * keyword content scans only that file).
 */
type SearchScopeTarget =
  | { kind: 'vault'; normalizedPath: '' }
  | { kind: 'folder'; folder: TFolder; normalizedPath: string }
  | { kind: 'file'; file: TFile; normalizedPath: string }

type RagEmbeddingRow = {
  path: string
  content: string
  metadata: { startLine: number; endLine: number; page?: number }
  similarity: number
}

const asErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  return typeof error === 'string' ? error : JSON.stringify(error)
}

const formatJsonResult = (payload: unknown): string => {
  return JSON.stringify(payload, null, 2)
}

const getOptionalTextArg = (
  args: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = args[key]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new Error(`${key} must be a string.`)
  }
  return value
}

const getOptionalBooleanArg = (
  args: Record<string, unknown>,
  key: string,
): boolean | undefined => {
  const value = args[key]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${key} must be a boolean.`)
  }
  return value
}

const getOptionalIntegerArg = ({
  args,
  key,
  defaultValue,
  min,
  max,
}: {
  args: Record<string, unknown>
  key: string
  defaultValue: number
  min: number
  max: number
}): number => {
  const value = args[key]
  if (value === undefined) {
    return defaultValue
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer.`)
  }
  if (value < min || value > max) {
    throw new Error(`${key} must be between ${min} and ${max}.`)
  }
  return value
}

const getOptionalBoundedIntegerArg = ({
  args,
  key,
  min,
  max,
}: {
  args: Record<string, unknown>
  key: string
  min: number
  max: number
}): number | undefined => {
  const value = args[key]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer.`)
  }
  if (value < min || value > max) {
    throw new Error(`${key} must be between ${min} and ${max}.`)
  }
  return value
}

const getOptionalBoundedFloatArg = (
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined => {
  const value = args[key]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${key} must be a number.`)
  }
  if (value < min || value > max) {
    throw new Error(`${key} must be between ${min} and ${max}.`)
  }
  return value
}

const getVaultSearchScope = (
  args: Record<string, unknown>,
): VaultSearchScope => {
  const value = args.scope
  if (
    value !== 'files' &&
    value !== 'dirs' &&
    value !== 'content' &&
    value !== 'all'
  ) {
    throw new Error('scope must be one of: files, dirs, content, all.')
  }
  return value
}

const getOptionalVaultSearchScope = (
  args: Record<string, unknown>,
  defaultScope: VaultSearchScope,
): VaultSearchScope => {
  if (args.scope === undefined) {
    return defaultScope
  }
  return getVaultSearchScope(args)
}

const getVaultSearchMode = (args: Record<string, unknown>): VaultSearchMode => {
  const value = args.mode
  if (value === undefined) {
    return 'hybrid'
  }
  if (value !== 'keyword' && value !== 'rag' && value !== 'hybrid') {
    throw new Error('mode must be one of: keyword, rag, hybrid.')
  }
  return value
}

const getSemanticSearchUnavailableReason = ({
  settings,
  getRagEngine,
}: {
  settings?: YoloSettings
  getRagEngine?: () => Promise<RAGEngine>
}): string | null => {
  if (!getRagEngine || !settings) {
    return 'Semantic search is not available in this context.'
  }
  if (!settings.ragOptions.enabled) {
    return 'RAG is not enabled. Fell back to keyword search.'
  }
  if (!settings.embeddingModelId?.trim()) {
    return 'No embedding model configured. Fell back to keyword search.'
  }
  return null
}

const resolveSearchScopeByPath = (
  app: App,
  rawPath: string | undefined,
): SearchScopeTarget => {
  const trimmedPath = rawPath?.trim()
  if (!trimmedPath || trimmedPath === '/') {
    return { kind: 'vault', normalizedPath: '' }
  }

  const normalizedPath = validateVaultPath(trimmedPath)
  const abstractFile = app.vault.getAbstractFileByPath(normalizedPath)

  if (!abstractFile) {
    throw new Error(`Path not found: ${normalizedPath}`)
  }
  if (abstractFile instanceof TFolder) {
    return { kind: 'folder', folder: abstractFile, normalizedPath }
  }
  if (abstractFile instanceof TFile) {
    return { kind: 'file', file: abstractFile, normalizedPath }
  }
  throw new Error(`Unsupported path target: ${normalizedPath}`)
}

const isPathWithinFolder = (filePath: string, folderPath: string): boolean => {
  if (!folderPath) {
    return true
  }
  return filePath.startsWith(`${folderPath}/`)
}

/** Whether a vault file path falls inside the active search scope. */
const isPathInSearchScope = (
  filePath: string,
  scope: SearchScopeTarget,
): boolean => {
  if (scope.kind === 'vault') return true
  if (scope.kind === 'folder')
    return isPathWithinFolder(filePath, scope.normalizedPath)
  return filePath === scope.normalizedPath
}

const makeContentSnippet = ({
  content,
  matchIndex,
  matchLength,
}: {
  content: string
  matchIndex: number
  matchLength: number
}): string => {
  const radius = 120
  const start = Math.max(0, matchIndex - radius)
  const end = Math.min(content.length, matchIndex + matchLength + radius)
  const snippet = content.slice(start, end).replace(/\s+/g, ' ').trim()

  const prefix = start > 0 ? '...' : ''
  const suffix = end < content.length ? '...' : ''
  return `${prefix}${snippet}${suffix}`
}

const truncateRagSnippet = (text: string): string => {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= MAX_RAG_SNIPPET_CHARS) {
    return normalized
  }
  return `${normalized.slice(0, MAX_RAG_SNIPPET_CHARS)}...`
}

const legacySearchItemsToSuper = (
  items: LegacySearchItem[],
  source: 'keyword' | 'rag',
): SuperSearchResult[] => {
  return items.map((item) => {
    if (item.kind === 'file') {
      return { kind: 'file', path: item.path, source }
    }
    if (item.kind === 'dir') {
      return { kind: 'dir', path: item.path, source }
    }
    return {
      kind: 'content',
      path: item.path,
      line: item.line,
      startLine: item.line,
      endLine: item.line,
      snippet: item.snippet,
      source,
    }
  })
}

const mapRagRowsToSuper = (
  rows: RagEmbeddingRow[],
  source: 'rag',
): SuperSearchResult[] => {
  return rows.map((row) => {
    const page = row.metadata.page
    const locLine = page ?? row.metadata.startLine
    const locEnd = page ?? row.metadata.endLine
    return {
      kind: 'content' as const,
      path: row.path,
      line: locLine,
      startLine: locLine,
      endLine: locEnd,
      page,
      snippet: truncateRagSnippet(row.content),
      similarity: row.similarity,
      source,
    }
  })
}

const pathToRagScope = (
  scope: SearchScopeTarget,
): { files: string[]; folders: string[] } | undefined => {
  if (scope.kind === 'vault') return undefined
  if (scope.kind === 'folder')
    return { files: [], folders: [scope.normalizedPath] }
  return { files: [scope.normalizedPath], folders: [] }
}

const collectKeywordSearchResults = async ({
  app,
  settings,
  scopeTarget,
  scope,
  query,
  maxResults,
  caseSensitive,
  signal,
}: {
  app: App
  settings?: YoloSettings
  scopeTarget: SearchScopeTarget
  scope: VaultSearchScope
  query: string
  maxResults: number
  caseSensitive: boolean
  signal?: AbortSignal
}): Promise<LegacySearchItem[]> => {
  const queryForMatch = caseSensitive ? query : query.toLowerCase()
  const queryTokens = Array.from(
    new Set(
      queryForMatch
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 0),
    ),
  )
  const effectiveTokens =
    queryTokens.length > 0 ? queryTokens : queryForMatch ? [queryForMatch] : []

  const getTokenMatchSummary = (
    sourceText: string,
  ): {
    matchedTokenCount: number
    firstMatchIndex: number
    bestMatchLength: number
  } | null => {
    if (!query) {
      return {
        matchedTokenCount: 0,
        firstMatchIndex: 0,
        bestMatchLength: 0,
      }
    }

    let matchedTokenCount = 0
    let firstMatchIndex = Number.MAX_SAFE_INTEGER
    let bestMatchLength = 0

    for (const token of effectiveTokens) {
      const matchIndex = sourceText.indexOf(token)
      if (matchIndex === -1) {
        continue
      }
      matchedTokenCount += 1
      if (matchIndex < firstMatchIndex) {
        firstMatchIndex = matchIndex
        bestMatchLength = token.length
      }
    }

    if (matchedTokenCount === 0) {
      return null
    }

    return {
      matchedTokenCount,
      firstMatchIndex,
      bestMatchLength,
    }
  }

  const getPathMatchSummary = (path: string) => {
    if (!query) {
      return {
        matchedTokenCount: 0,
        firstMatchIndex: 0,
        bestMatchLength: 0,
      }
    }

    const sourceText = caseSensitive ? path : path.toLowerCase()
    return getTokenMatchSummary(sourceText)
  }

  const includeFiles = scope === 'files' || scope === 'all'
  const includeDirs = scope === 'dirs' || scope === 'all'
  const includeContent = scope === 'content' || scope === 'all'

  if (includeContent && !query) {
    throw new Error('query is required when scope includes content.')
  }

  const results: LegacySearchItem[] = []
  if (includeFiles) {
    const files = app.vault
      .getFiles()
      .filter((file) => isPathInSearchScope(file.path, scopeTarget))
      .filter((file) => !isWithinYoloUserDataRoot(file.path, settings))
      .map((file) => file.path)
      .map((path) => ({
        path,
        match: getPathMatchSummary(path),
      }))
      .filter(
        (
          entry,
        ): entry is {
          path: string
          match: {
            matchedTokenCount: number
            firstMatchIndex: number
            bestMatchLength: number
          }
        } => entry.match !== null,
      )
      .sort((a, b) => {
        if (a.match.matchedTokenCount !== b.match.matchedTokenCount) {
          return b.match.matchedTokenCount - a.match.matchedTokenCount
        }
        if (a.match.firstMatchIndex !== b.match.firstMatchIndex) {
          return a.match.firstMatchIndex - b.match.firstMatchIndex
        }
        return a.path.localeCompare(b.path)
      })

    for (const fileEntry of files) {
      if (results.length >= maxResults) break
      results.push({ kind: 'file', path: fileEntry.path })
    }
  }

  if (includeDirs && results.length < maxResults) {
    const dirs = app.vault
      .getAllLoadedFiles()
      .filter((entry): entry is TFolder => entry instanceof TFolder)
      .filter((folder) => folder.path.length > 0)
      .filter((folder) => isPathInSearchScope(folder.path, scopeTarget))
      .filter((folder) => !isWithinYoloUserDataRoot(folder.path, settings))
      .map((folder) => folder.path)
      .map((path) => ({
        path,
        match: getPathMatchSummary(path),
      }))
      .filter(
        (
          entry,
        ): entry is {
          path: string
          match: {
            matchedTokenCount: number
            firstMatchIndex: number
            bestMatchLength: number
          }
        } => entry.match !== null,
      )
      .sort((a, b) => {
        if (a.match.matchedTokenCount !== b.match.matchedTokenCount) {
          return b.match.matchedTokenCount - a.match.matchedTokenCount
        }
        if (a.match.firstMatchIndex !== b.match.firstMatchIndex) {
          return a.match.firstMatchIndex - b.match.firstMatchIndex
        }
        return a.path.localeCompare(b.path)
      })

    for (const dirEntry of dirs) {
      if (results.length >= maxResults) break
      results.push({ kind: 'dir', path: dirEntry.path })
    }
  }

  if (includeContent && results.length < maxResults) {
    const searchableFiles = app.vault
      .getMarkdownFiles()
      .filter((file) => isPathInSearchScope(file.path, scopeTarget))
      .sort((a, b) => a.path.localeCompare(b.path))
    const contentMatches: Array<{
      kind: 'content_match'
      path: string
      line: number
      snippet: string
      matchedTokenCount: number
      firstMatchIndex: number
    }> = []

    for (const file of searchableFiles) {
      if (signal?.aborted) {
        break
      }
      if (file.stat.size > MAX_FILE_SIZE_BYTES) {
        continue
      }

      const content = await app.vault.read(file)
      const source = caseSensitive ? content : content.toLowerCase()
      const match = getTokenMatchSummary(source)
      if (!match) {
        continue
      }

      const matchIndex = match.firstMatchIndex
      const line = content.slice(0, matchIndex).split('\n').length
      const snippet = makeContentSnippet({
        content,
        matchIndex,
        matchLength: match.bestMatchLength,
      })
      contentMatches.push({
        kind: 'content_match',
        path: file.path,
        line,
        snippet,
        matchedTokenCount: match.matchedTokenCount,
        firstMatchIndex: match.firstMatchIndex,
      })
    }

    contentMatches
      .sort((a, b) => {
        if (a.matchedTokenCount !== b.matchedTokenCount) {
          return b.matchedTokenCount - a.matchedTokenCount
        }
        if (a.firstMatchIndex !== b.firstMatchIndex) {
          return a.firstMatchIndex - b.firstMatchIndex
        }
        if (a.line !== b.line) {
          return a.line - b.line
        }
        return a.path.localeCompare(b.path)
      })
      .slice(0, Math.max(maxResults - results.length, 0))
      .forEach(
        ({
          matchedTokenCount: _matchedTokenCount,
          firstMatchIndex: _firstMatchIndex,
          ...item
        }) => {
          void _matchedTokenCount
          void _firstMatchIndex
          results.push(item)
        },
      )
  }

  return results
}

/**
 * Runs a keyword / RAG / hybrid vault search and returns structured,
 * aggregated results. Mirrors the retired internal `fs_search` tool's
 * behavior exactly: same argument parsing and same mode fallback semantics
 * (hybrid falls back to keyword when RAG is unavailable; explicit rag stays
 * strict). `runVaultSearch` wraps this into the `vault_search` JSON shape;
 * the bash `search` command consumes the structured form directly.
 */
export async function runVaultSearchStructured({
  app,
  settings,
  getRagEngine,
  args,
  signal,
}: {
  app: App
  settings?: YoloSettings
  getRagEngine?: () => Promise<RAGEngine>
  args: Record<string, unknown>
  signal?: AbortSignal
}): Promise<VaultSearchStructuredOutcome> {
  if (signal?.aborted) {
    return { status: 'aborted' }
  }

  try {
    const requestedMode = getVaultSearchMode(args)
    const query = (getOptionalTextArg(args, 'query') ?? '').trim()
    const maxResults = getOptionalIntegerArg({
      args,
      key: 'maxResults',
      defaultValue: 20,
      min: 1,
      max: 300,
    })
    const caseSensitive = getOptionalBooleanArg(args, 'caseSensitive') ?? false
    const scopeTarget = resolveSearchScopeByPath(
      app,
      getOptionalTextArg(args, 'path'),
    )
    const ragMinSimilarity = getOptionalBoundedFloatArg(
      args,
      'ragMinSimilarity',
      0,
      1,
    )
    const ragLimitArg = getOptionalBoundedIntegerArg({
      args,
      key: 'ragLimit',
      min: 1,
      max: RAG_FETCH_LIMIT_MAX,
    })
    const semanticUnavailableReason =
      requestedMode === 'keyword'
        ? null
        : getSemanticSearchUnavailableReason({ settings, getRagEngine })
    const effectiveMode: VaultSearchMode =
      requestedMode === 'hybrid' && semanticUnavailableReason
        ? 'keyword'
        : requestedMode

    if (effectiveMode === 'keyword') {
      const scope = getOptionalVaultSearchScope(args, 'all')
      const legacy = await collectKeywordSearchResults({
        app,
        settings,
        scopeTarget,
        scope,
        query,
        maxResults,
        caseSensitive,
        signal,
      })
      if (signal?.aborted) {
        return { status: 'aborted' }
      }
      const results = legacySearchItemsToSuper(legacy, 'keyword')
      return {
        status: 'success',
        requestedMode,
        effectiveMode,
        fallbackReason:
          requestedMode !== effectiveMode
            ? (semanticUnavailableReason ?? undefined)
            : undefined,
        scope,
        query,
        path: scopeTarget.normalizedPath,
        results: aggregateSearchResults({ results, maxResults }),
      }
    }

    if (semanticUnavailableReason) {
      throw new Error(
        semanticUnavailableReason.replace(' Fell back to keyword search.', ''),
      )
    }
    if (!query) {
      throw new Error('query is required for rag/hybrid mode.')
    }
    if (!getRagEngine || !settings) {
      throw new Error('Semantic search is not available in this context.')
    }

    const rawScope = args.scope
    if (rawScope === 'files' || rawScope === 'dirs') {
      throw new Error(
        'rag mode only supports content search. Use keyword or hybrid for file/dir search.',
      )
    }

    const ragEngine = await getRagEngine()
    const ragScope = pathToRagScope(scopeTarget)

    const effectiveRagLimit = Math.min(
      ragLimitArg ?? settings.ragOptions.limit,
      RAG_FETCH_LIMIT_MAX,
    )

    const ragRows = await ragEngine.processQuery({
      query,
      scope: ragScope,
      minSimilarity: ragMinSimilarity,
      limit: effectiveRagLimit,
    })

    const ragMapped = mapRagRowsToSuper(ragRows as RagEmbeddingRow[], 'rag')

    if (effectiveMode === 'rag') {
      const effectiveScope: VaultSearchScope =
        rawScope === undefined ? 'content' : (rawScope as VaultSearchScope)
      const results = ragMapped.slice(0, maxResults)
      return {
        status: 'success',
        requestedMode,
        effectiveMode: 'rag',
        scope: effectiveScope,
        query,
        path: scopeTarget.normalizedPath,
        results: aggregateSearchResults({ results, maxResults }),
      }
    }

    const keywordLegacy = await collectKeywordSearchResults({
      app,
      settings,
      scopeTarget,
      scope: 'content',
      query,
      maxResults,
      caseSensitive,
      signal,
    })
    if (signal?.aborted) {
      return { status: 'aborted' }
    }
    const keywordSuper = legacySearchItemsToSuper(keywordLegacy, 'keyword')
    const pathLegacyFiles = await collectKeywordSearchResults({
      app,
      settings,
      scopeTarget,
      scope: 'files',
      query,
      maxResults,
      caseSensitive,
      signal,
    })
    if (signal?.aborted) {
      return { status: 'aborted' }
    }
    const pathLegacyDirs = await collectKeywordSearchResults({
      app,
      settings,
      scopeTarget,
      scope: 'dirs',
      query,
      maxResults,
      caseSensitive,
      signal,
    })
    if (signal?.aborted) {
      return { status: 'aborted' }
    }
    const pathSuper = legacySearchItemsToSuper(
      [...pathLegacyFiles, ...pathLegacyDirs],
      'keyword',
    )
    const fused = fuseRrfHybrid({
      pathResults: pathSuper,
      keywordResults: keywordSuper,
      ragResults: ragMapped,
      maxResults,
    })
    return {
      status: 'success',
      requestedMode,
      effectiveMode: 'hybrid',
      scope: 'content',
      query,
      path: scopeTarget.normalizedPath,
      results: aggregateSearchResults({ results: fused, maxResults }),
    }
  } catch (error) {
    return { status: 'error', error: asErrorMessage(error) }
  }
}

/**
 * `vault_search` MCP entry point: same orchestration as
 * `runVaultSearchStructured`, serialized into the legacy fs_search JSON
 * response shape (`fallbackReason: undefined` is dropped by JSON.stringify,
 * matching the historical output byte-for-byte).
 */
export async function runVaultSearch(options: {
  app: App
  settings?: YoloSettings
  getRagEngine?: () => Promise<RAGEngine>
  args: Record<string, unknown>
  signal?: AbortSignal
}): Promise<VaultSearchOutcome> {
  const outcome = await runVaultSearchStructured(options)
  if (outcome.status !== 'success') {
    return outcome
  }
  return {
    status: 'success',
    text: formatJsonResult({
      tool: 'fs_search',
      requestedMode: outcome.requestedMode,
      effectiveMode: outcome.effectiveMode,
      fallbackReason: outcome.fallbackReason,
      scope: outcome.scope,
      query: outcome.query,
      path: outcome.path,
      results: outcome.results,
    }),
  }
}
