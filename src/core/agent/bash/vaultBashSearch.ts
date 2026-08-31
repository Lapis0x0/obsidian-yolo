import type { App } from 'obsidian'

import type { YoloSettings } from '../../../settings/schema/setting.types'
import type { AssistantWorkspaceScope } from '../../../types/assistant.types'
import { runVaultSearchStructured } from '../../mcp/vaultSearchService'
import type { RagKnowledgeAccess } from '../../rag/ragAccess'
import type {
  BashSearchCallback,
  BashSearchResultEntry,
} from '../../runtime-components/contracts'
import { resolvePathVisibility } from '../workspaceScope'

/**
 * Host implementation behind the bash tool's custom `search` command:
 * hybrid (RAG + keyword RRF) retrieval via `runVaultSearchStructured`, which
 * itself degrades to keyword ranking when RAG is unavailable — so the
 * command is always registered regardless of embedding configuration.
 *
 * `workspaceScope` is passed straight into `runVaultSearchStructured`, which
 * now applies it *before* retrieval — pre-filtering the RAG vector scan and
 * the keyword sweeps rather than only trimming their output — so a narrow
 * scope no longer needs an over-sized request to compensate (there used to
 * be a `SEARCH_MAX_REQUEST` here for exactly that; it's gone now that
 * filtering happens before ranking, not after).
 *
 * The per-result `resolvePathVisibility` check below stays anyway, as cheap
 * defense in depth: it is the actual security boundary for this command (the
 * fs callbacks gate every path the shell's own commands touch — see
 * `vaultBashFileSystem.ts` — but this custom command reaches the search
 * index directly), so it must not depend on `vaultSearchService` continuing
 * to filter correctly on every path.
 */
export function createVaultBashSearch({
  app,
  settings,
  ragAccess,
  workspaceScope,
  signal,
}: {
  app: App
  settings?: YoloSettings
  ragAccess?: RagKnowledgeAccess
  workspaceScope?: AssistantWorkspaceScope
  signal?: AbortSignal
}): BashSearchCallback {
  return async ({ query, scopePath, maxResults, knowledgeBase }) => {
    // `hidden` is judged unconditionally — the YOLO user-data root stays
    // invisible whether or not a workspace scope is configured — and keeps
    // its not-found disguise instead of being reported as a scope violation.
    if (scopePath !== undefined) {
      const visibility = resolvePathVisibility(scopePath, {
        scope: workspaceScope,
        settings,
      })
      if (visibility === 'hidden') {
        return {
          status: 'error',
          message: `no such file or directory: '${scopePath}'`,
        }
      }
      if (visibility === 'out-of-scope') {
        return {
          status: 'error',
          message: `path is outside the allowed workspace scope: '${scopePath}'`,
        }
      }
    }

    const outcome = await runVaultSearchStructured({
      app,
      settings,
      ragAccess,
      workspaceScope,
      args: {
        query,
        path: scopePath,
        maxResults,
        mode: 'hybrid',
        knowledgeBase,
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
      // Defense in depth, unconditional: `vaultSearchService` already
      // pre-filters by workspace scope and the hidden root before
      // retrieval, but this per-result check is the actual security
      // boundary for this command and must not depend on that staying true.
      if (
        resolvePathVisibility(result.path, {
          scope: workspaceScope,
          settings,
        }) !== 'visible'
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
