import type { App } from 'obsidian'

import type { KnowledgeBase } from '../../../settings/schema/setting.types'
import type { McpTool } from '../../../types/mcp.types'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import { resolvePathVisibility } from '../../agent/workspaceScope'
import { runVaultSearchStructured } from '../../mcp/vaultSearchService'
import { describeKnowledgeBaseCatalog } from '../../rag/knowledgeBaseCatalog'
import { defineTool } from '../define'
import {
  type NativePathBoundary,
  isAbsoluteNativePath,
  isInsideVault,
  resolveNativePathBoundary,
  resolveNativePathWithin,
  toEditSummaryPath,
} from '../native/paths'
import {
  formatJsonResult,
  getOptionalBoundedIntegerArg,
  getOptionalTextArg,
  getTextArg,
} from '../tool-args'

const MAX_RESULTS_CAP = 300

const VAULT_SEARCH_DESCRIPTION =
  'Semantic vector search over the vault, when a RAG knowledge base is configured.'

/**
 * @param knowledgeBases When given, the `knowledgeBase` argument lists the
 * configured bases by name; the settings-agnostic catalog omits it and
 * `applyDynamicToolDescriptions` fills it in per request — the same
 * arrangement `bash` and `js_eval` use for their own knowledge-base hints.
 */
export function buildVaultSearchInputSchema(
  knowledgeBases?: readonly KnowledgeBase[],
): McpTool['inputSchema'] {
  return {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'What to look for.',
      },
      path: {
        type: 'string',
        description:
          'Restrict the search to one file or folder. Vault-relative or absolute.',
      },
      maxResults: {
        type: 'integer',
        description: `Maximum results to return (1-${MAX_RESULTS_CAP}). Defaults to 20.`,
      },
      knowledgeBase: {
        type: 'string',
        description: `Restrict semantic retrieval to one knowledge base by name (case-insensitive).${
          knowledgeBases
            ? ` ${describeKnowledgeBaseCatalog(knowledgeBases)}`
            : ''
        }`,
      },
    },
    required: ['query'],
  }
}

export const vaultSearchDefinition = defineTool({
  name: 'vault_search',
  summaryAction: 'search',
  getMcpTool: () => ({
    description: VAULT_SEARCH_DESCRIPTION,
    inputSchema: buildVaultSearchInputSchema(),
  }),
  chatLabel: {
    key: 'settings.agent.builtinVaultSearchLabel',
    fallback: 'Vault Search',
  },
  contextPrunable: true,
  execute: async (args, ctx) => {
    const { app, settings, ragAccess, workspaceScope, signal } = ctx
    const query = getTextArg(args, 'query')
    const scopePath = toVaultRelativeScopePath(
      app,
      getOptionalTextArg(args, 'path'),
    )

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
          status: ToolCallResponseStatus.Error,
          error: `no such file or directory: '${scopePath}'`,
        }
      }
      if (visibility === 'out-of-scope') {
        return {
          status: ToolCallResponseStatus.Error,
          error: `path is outside the allowed workspace scope: '${scopePath}'`,
        }
      }
    }

    const outcome = await runVaultSearchStructured({
      app,
      settings,
      ragAccess,
      // Passed in so `runVaultSearchStructured` applies the assistant's
      // workspace scope *before* retrieval — pre-filtering the RAG vector
      // scan and the keyword sweeps rather than only trimming their output.
      workspaceScope,
      args: {
        query,
        path: scopePath,
        maxResults: getOptionalBoundedIntegerArg({
          args,
          key: 'maxResults',
          min: 1,
          max: MAX_RESULTS_CAP,
        }),
        // Fixed, not a model-facing argument: hybrid is the only mode that
        // answers "find this in my vault" well, and it is the only one that
        // degrades to keyword ranking on its own when RAG is unconfigured
        // (explicit `rag` stays strict and would fail instead).
        //
        // `scope` is deliberately not passed either. Hybrid ignores it and
        // fuses file-name, folder-name and content sweeps regardless; the
        // value that matters is the one the degraded keyword path defaults
        // to, and that default (`'all'`) is exactly that same three-way
        // sweep. Pinning `'content'` here would silently drop file-name
        // matches from the RAG-unavailable case only.
        mode: 'hybrid',
        knowledgeBase: getOptionalTextArg(args, 'knowledgeBase'),
      },
      signal,
    })
    if (outcome.status === 'aborted') {
      return { status: ToolCallResponseStatus.Aborted }
    }
    if (outcome.status === 'error') {
      return { status: ToolCallResponseStatus.Error, error: outcome.error }
    }

    // Defense in depth, unconditional: `vaultSearchService` already
    // pre-filters by workspace scope and the hidden root before retrieval,
    // but this per-result check is the actual security boundary for this
    // tool — it reaches the search index directly rather than going through
    // a path-gated filesystem layer — and must not depend on that staying
    // true on every code path.
    const results = outcome.results.filter(
      (result) =>
        resolvePathVisibility(result.path, {
          scope: workspaceScope,
          settings,
        }) === 'visible',
    )

    return {
      status: ToolCallResponseStatus.Success,
      text: formatJsonResult({
        tool: 'vault_search',
        // `requestedMode` is dropped from `runVaultSearch`'s payload: it is
        // always `hybrid` here, so it would carry no information. What the
        // model does need is whether RAG actually ran — `effectiveMode`
        // plus `fallbackReason` say so (both absent from a normal run).
        effectiveMode: outcome.effectiveMode,
        fallbackReason: outcome.fallbackReason,
        scope: outcome.scope,
        query: outcome.query,
        path: outcome.path,
        results,
      }),
    }
  },
})

/**
 * The `path` argument in the vault-relative form `runVaultSearchStructured`
 * expects. A relative path is already that form; an absolute one is accepted
 * because Max-mode models work in absolute paths throughout (the native file
 * tools take them), and is converted against the same vault boundary those
 * tools resolve with. Outside the vault there is nothing to search: semantic
 * retrieval only covers the vault index.
 */
const toVaultRelativeScopePath = (
  app: App,
  inputPath: string | undefined,
): string | undefined => {
  if (inputPath === undefined) {
    return undefined
  }
  const raw = inputPath.trim()
  if (raw === '' || !isAbsoluteNativePath(raw)) {
    return raw === '' ? undefined : raw
  }

  // A vault with no local filesystem root (mobile) has no absolute path
  // inside it, so a boundary that cannot be resolved and a real out-of-vault
  // path are the same answer to the model.
  const boundary = tryResolveNativePathBoundary(app)
  const absolute = boundary && resolveNativePathWithin(boundary, raw)
  if (
    !boundary ||
    !absolute ||
    !isInsideVault(absolute, boundary.vaultBasePath)
  ) {
    throw new Error(
      `path is outside the vault: '${raw}'. vault_search only covers files indexed in this vault.`,
    )
  }
  const relative = toEditSummaryPath(absolute, boundary.vaultBasePath)
  // The vault root itself keeps its absolute form out of `toEditSummaryPath`;
  // as a search scope it just means "the whole vault".
  return relative === absolute ? undefined : relative
}

const tryResolveNativePathBoundary = (app: App): NativePathBoundary | null => {
  try {
    return resolveNativePathBoundary(app)
  } catch {
    return null
  }
}
