import type { App } from 'obsidian'

import type { YoloSettings } from '../../../settings/schema/setting.types'
import type { AssistantWorkspaceScope } from '../../../types/assistant.types'
import { runVaultSearchStructured } from '../../mcp/vaultSearchService'
import type { RAGEngine } from '../../rag/ragEngine'
import type {
  BashSearchCallback,
  BashSearchResultEntry,
} from '../../runtime-components/contracts'
import { resolvePathVisibility } from '../workspaceScope'

// Scope filtering happens after retrieval, so out-of-scope hits can outrank
// in-scope ones and leave the caller short. With a scope active we therefore
// ask for the service's full cap and slice down to what the caller wanted:
// search should look the same to the agent whether or not a scope is set.
//
// Asking for the cap is free rather than a tradeoff. The keyword sweep reads
// every markdown file and matches it before `maxResults` slices the ranking
// (`vaultSearchService.ts`'s `getMarkdownFiles()` loop), so the request size
// changes nothing about the work done — only how much of the finished
// ranking comes back.
//
// One request, never a grow-and-retry loop: re-running would redo that whole
// sweep for candidates it already had, and it could not tell when to stop
// anyway — the RAG branch truncates raw hits and *then* aggregates them per
// file, so a short list never implies the candidates were exhausted.
//
// The semantic side is deliberately left alone (no `ragLimit` override): its
// candidate pool is capped by the vector store's `ef_search`, not by what we
// request, so widening the request cannot widen the pool — filtered-out RAG
// hits are simply lost, and hybrid ranking leans on the keyword side to make
// up the count. Raising `ef_search` is the only real lever there and it costs
// proportional graph traversal, so it stays out of scope here.
const SEARCH_MAX_REQUEST = 300

/**
 * Host implementation behind the bash tool's custom `search` command:
 * hybrid (RAG + keyword RRF) retrieval via `runVaultSearchStructured`, which
 * itself degrades to keyword ranking when RAG is unavailable — so the
 * command is always registered regardless of embedding configuration.
 *
 * Workspace scope is enforced here, not in the component: the fs callbacks
 * gate every path the shell touches (see `vaultBashFileSystem.ts`), but the
 * search index is queried vault-wide, so both the scope argument and each
 * result path must be checked against the same rules. The same check also
 * carries the YOLO user-data root: `vaultSearchService` filters it out of its
 * filename and folder sweeps, but its content sweep builds its own
 * `getMarkdownFiles()` list without that filter, so this is the layer that
 * actually keeps user-data content out of agent-visible search results.
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
      getRagEngine,
      args: {
        query,
        path: scopePath,
        maxResults:
          workspaceScope?.enabled === true ? SEARCH_MAX_REQUEST : maxResults,
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
      // Unconditional again: the search index is queried vault-wide, and
      // `vaultSearchService`'s own hidden filter covers its filename/folder
      // sweeps but not its content sweep, so this is the layer that keeps
      // user-data content out of agent-visible results.
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
