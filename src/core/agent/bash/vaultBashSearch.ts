import type { App } from 'obsidian'

import type { YoloSettings } from '../../../settings/schema/setting.types'
import type { AssistantWorkspaceScope } from '../../../types/assistant.types'
import { runVaultSearchStructured } from '../../mcp/vaultSearchService'
import type { RAGEngine } from '../../rag/ragEngine'
import type {
  BashSearchCallback,
  BashSearchResultEntry,
} from '../../runtime-components/contracts'
import { isPathAllowedByScope } from '../workspaceScope'

/**
 * Host implementation behind the bash tool's custom `search` command:
 * hybrid (RAG + keyword RRF) retrieval via `runVaultSearchStructured`, which
 * itself degrades to keyword ranking when RAG is unavailable — so the
 * command is always registered regardless of embedding configuration.
 *
 * Workspace scope is enforced here, not in the component: the fs callbacks
 * gate every path the shell touches (see `vaultBashFileSystem.ts`), but the
 * search index is queried vault-wide, so both the scope argument and each
 * result path must be checked against the same rules.
 */
export function createVaultBashSearch({
  app,
  settings,
  getRagEngine,
  workspaceScope,
  signal,
}: {
  app: App
  settings?: YoloSettings
  getRagEngine?: () => Promise<RAGEngine>
  workspaceScope?: AssistantWorkspaceScope
  signal?: AbortSignal
}): BashSearchCallback {
  return async ({ query, scopePath, maxResults }) => {
    if (
      scopePath !== undefined &&
      workspaceScope?.enabled &&
      !isPathAllowedByScope(scopePath, workspaceScope)
    ) {
      return {
        status: 'error',
        message: `path is outside the allowed workspace scope: '${scopePath}'`,
      }
    }

    const outcome = await runVaultSearchStructured({
      app,
      settings,
      getRagEngine,
      args: {
        query,
        path: scopePath,
        maxResults,
        mode: 'hybrid',
      },
      signal,
    })
    if (outcome.status === 'aborted') {
      return { status: 'error', message: 'aborted' }
    }
    if (outcome.status === 'error') {
      return { status: 'error', message: outcome.error }
    }

    const entries: BashSearchResultEntry[] = []
    for (const result of outcome.results) {
      if (entries.length >= maxResults) break
      if (
        workspaceScope?.enabled &&
        !isPathAllowedByScope(result.path, workspaceScope)
      ) {
        continue
      }
      if (result.kind === 'content_group') {
        for (const snippet of result.snippets) {
          if (entries.length >= maxResults) break
          entries.push({
            kind: 'content',
            path: result.path,
            startLine: snippet.startLine ?? snippet.line,
            endLine: snippet.endLine,
            page: snippet.page,
            snippet: snippet.snippet,
          })
        }
      } else {
        entries.push({ kind: result.kind, path: result.path })
      }
    }

    return {
      status: 'success',
      results: entries,
      notice: outcome.fallbackReason,
    }
  }
}
