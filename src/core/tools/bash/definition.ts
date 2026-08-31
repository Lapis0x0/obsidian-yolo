import type { KnowledgeBase } from '../../../settings/schema/setting.types'
import type { McpTool } from '../../../types/mcp.types'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import {
  type DangerousBashOperationKind,
  cancelDangerousBashApproval,
  requestDangerousBashApproval,
} from '../../agent/bash/dangerousOperationGate'
import {
  VAULT_BASH_STDERR_BUDGET,
  VAULT_BASH_STDOUT_BUDGET,
  truncateBashOutputForContext,
} from '../../agent/bash/outputBudget'
import { createVaultBashFileSystem } from '../../agent/bash/vaultBashFileSystem'
import { createVaultBashSearch } from '../../agent/bash/vaultBashSearch'
import { describeKnowledgeBaseCatalog } from '../../rag/knowledgeBaseCatalog'
import {
  acquireRuntimeComponent,
  isRuntimeComponentEnabled,
} from '../../runtime-components/runtimeComponentAccess'
import { defineTool } from '../define'
import { getTextArg } from '../tool-args'

// Schema copied verbatim from the `bash` entry in `getLocalFileTools()`
// (`src/core/mcp/localFileTools.ts`). `getMcpTool` only ever describes the
// protocol shape — it stays unconditional; whether the tool is currently
// offered is `isAvailable`'s job (see below, D6b).
/**
 * @param knowledgeBases When given, the `search --kb` hint lists the
 * configured knowledge bases by name; the settings-agnostic catalog omits it
 * and `applyDynamicToolDescriptions` fills it in per request.
 */
export function buildBashToolDescription(
  knowledgeBases?: readonly KnowledgeBase[],
): string {
  return `A sandboxed virtual shell over the vault, mounted at /vault (cwd defaults there); nothing outside /vault exists. To read a file, call the separate \`fs_read\` tool — this shell has no read command. To search, use the \`search [-n N] [--kb "NAME"] "query" [path]\` command inside this shell (hybrid RAG + keyword retrieval; \`--kb\` restricts semantic retrieval to one knowledge base by name).${knowledgeBases ? ` ${describeKnowledgeBaseCatalog(knowledgeBases)}` : ''} Path operations — mkdir, mv, rm — run directly here. Content writes are unavailable here — call the separate \`fs_edit\` or \`fs_write\` tool instead.`
}

const BASH_MCP_TOOL: Omit<McpTool, 'name'> = {
  description: buildBashToolDescription(),
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command line to run.',
      },
    },
    required: ['command'],
  },
}

export const bashDefinition = defineTool({
  name: 'bash',
  getMcpTool: () => BASH_MCP_TOOL,
  // D6b: this tool's catalog-inclusion gate — previously
  // `isRuntimeComponentEnabled('bash-engine')` embedded directly inside
  // `getLocalFileTools()`'s array-building conditional — now lives here as
  // this tool's own `isAvailable`, the same dimension `web_search`'s
  // provider-readiness gate and `terminal_command`'s platform gate already
  // use (master.md §3.1b). `getLocalFileTools()` still explicitly consults
  // this (see that function's own comment) rather than applying `isAvailable`
  // uniformly to every registered tool: `ToolCatalogContext` carries no
  // `settings` snapshot, so a uniform pass there would silently drop
  // `web_search` (whose `isAvailable` needs `settings`) from every catalog
  // built without one — including the settings-page call sites that need the
  // full, unfiltered tool list to render toggles regardless of runtime
  // readiness (decision 18). `isRuntimeComponentEnabled` is a synchronous,
  // side-effect-free global read (see its own doc comment) — exactly like
  // `terminal_command`'s `Platform.isDesktop` check — so no `ToolContext`
  // threading is needed for it.
  isAvailable: () => isRuntimeComponentEnabled('bash-engine'),
  chatLabel: {
    key: 'settings.agent.builtinBashLabel',
    fallback: 'Bash (Vault Shell)',
  },
  contextPrunable: true,
  // Ported verbatim from the `case BASH_TOOL_NAME` branch of
  // `callLocalFileTool` (`src/core/mcp/localFileTools.ts`), minus the abort
  // check / workspace-scope / YOLO-data-root guards and the outer try/catch
  // that normalizes thrown errors to an Error-status result — those are
  // dispatcher responsibilities (master.md §3.4), not tool semantics.
  //
  // Note on the security boundary (master.md §5, decision documented in this
  // batch's task brief): `bash`'s per-path enforcement happens *inside*
  // `createVaultBashFileSystem` below, at the virtual filesystem layer, not
  // via the dispatcher's parameter-level `findPathOutsideScope` scan — this
  // tool's only argument is an opaque `command` string, so there is no path
  // literal for the dispatcher to see. This mirrors why `fs_read`'s wikilink
  // resolution stayed inside that tool (see `fs_read/definition.ts`). Do not
  // duplicate a parameter-level path check here; `createVaultBashFileSystem`
  // (untouched by this migration) is the single, already-tested enforcement
  // point (`core/agent/bash/vaultBashFileSystem.test.ts`).
  execute: async (args, ctx) => {
    const {
      app,
      settings,
      workspaceScope,
      ragAccess,
      signal,
      toolCallId,
      bashApprovalMode,
      bashReadOnly,
    } = ctx
    const command = getTextArg(args, 'command')
    const lease = await acquireRuntimeComponent('bash-engine')
    try {
      const fs = createVaultBashFileSystem(app, workspaceScope, settings)
      const confirmDangerousOperation = async (
        kind: DangerousBashOperationKind,
        targets: readonly string[],
      ): Promise<boolean> => {
        // 'full_access': nothing to gate. 'require_approval': the whole
        // call was already approved before execution started (see
        // tool-gateway.ts's pre-call gate) — asking again mid-script
        // would be redundant. Only the default 'dangerous_only' tier (and
        // any unrecognized value, failing toward the safer behavior)
        // pauses here.
        if (
          bashApprovalMode === 'full_access' ||
          bashApprovalMode === 'require_approval'
        ) {
          return true
        }
        // No addressable tool call to attach an approval card to (should
        // not happen in practice — every real dispatch has a toolCallId).
        // Fail closed rather than silently allowing a destructive op.
        if (!toolCallId) return false
        return requestDangerousBashApproval(toolCallId, kind, targets)
      }
      const session = lease.api.createSession({
        fs,
        confirmDangerousOperation,
        search: createVaultBashSearch({
          app,
          settings,
          ragAccess,
          workspaceScope,
          signal,
        }),
        signal,
        readOnly: bashReadOnly ?? false,
      })
      const onAbort = (): void => {
        if (toolCallId) cancelDangerousBashApproval(toolCallId)
      }
      signal?.addEventListener('abort', onAbort)
      try {
        const result = await session.exec(command)
        return {
          status: ToolCallResponseStatus.Success,
          text: JSON.stringify(
            {
              tool: 'bash',
              exit_code: result.exitCode,
              stdout: truncateBashOutputForContext(
                result.stdout,
                VAULT_BASH_STDOUT_BUDGET,
              ),
              stderr: truncateBashOutputForContext(
                result.stderr,
                VAULT_BASH_STDERR_BUDGET,
              ),
            },
            null,
            2,
          ),
        }
      } finally {
        signal?.removeEventListener('abort', onAbort)
        session.dispose()
      }
    } finally {
      lease.release()
    }
  },
})
