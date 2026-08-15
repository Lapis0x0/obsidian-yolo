import {
  App,
  FileSystemAdapter,
  Platform,
  TFile,
  TFolder,
  normalizePath,
} from 'obsidian'

import { buildPdfPageImageCacheKey } from '../../database/json/chat/imageCacheStore'
import type { YoloSettings } from '../../settings/schema/setting.types'
import type {
  ApplyViewResult,
  ApplyViewState,
} from '../../types/apply-view.types'
import type {
  AssistantToolApprovalMode,
  AssistantWorkspaceScope,
} from '../../types/assistant.types'
import type { ChatMessage } from '../../types/chat'
import type { ChatModelModality } from '../../types/chat-model.types'
import type { ContentPart } from '../../types/llm/request'
import { McpTool } from '../../types/mcp.types'
import {
  ToolCallResponseStatus,
  type ToolFsReadOperationSummary,
} from '../../types/tool-call.types'
import { uint8ArrayToBase64 } from '../../utils/base64'
import { collectWikilinkPaths } from '../../utils/llm/annotate-wikilinks'
import { extractMarkdownImages } from '../../utils/llm/extract-markdown-images'
import {
  chatModelSupportsPdf,
  chatModelSupportsVision,
} from '../../utils/llm/model-modalities'
import {
  type WikilinkReadSubpath,
  resolveWikilinkReadTarget,
} from '../../utils/llm/resolve-wikilink-target'
import { parseOfficeDocument } from '../../utils/office'
import {
  PDF_INDEX_MAX_BYTES,
  PDF_INDEX_MAX_PAGES,
  extractPdfText,
} from '../../utils/pdf/extractPdfText'
import { renderPdfPagesToImages } from '../../utils/pdf/renderPdfPagesToImages'
import { PdfSliceError, slicePdfPages } from '../../utils/pdf/slicePdfPages'
import {
  type DangerousBashOperationKind,
  cancelDangerousBashApproval,
  requestDangerousBashApproval,
} from '../agent/bash/dangerousOperationGate'
import {
  VAULT_BASH_STDERR_BUDGET,
  VAULT_BASH_STDOUT_BUDGET,
  truncateBashOutputForContext,
} from '../agent/bash/outputBudget'
import { createVaultBashFileSystem } from '../agent/bash/vaultBashFileSystem'
import { createVaultBashSearch } from '../agent/bash/vaultBashSearch'
import type { PromptSourceWatcher } from '../agent/promptSourceWatcher'
import { resolveSubagentModelConfig } from '../agent/subagent/model-config'
import type { SubagentParentContext } from '../agent/subagent/parent-context'
import type { TodoItem } from '../agent/todos-from-messages'
import type { AgentRunContext } from '../agent/types'
import {
  buildAllowedSkillPathSet,
  isCoveredBySkillPathExemption,
  isPathAllowedByScope,
  normalizeSkillPathForExemption,
} from '../agent/workspaceScope'
import { findWebviewHandleByPageId } from '../browser/activeWebviewProbe'
import {
  BrowserReadFailure,
  readActiveWebviewPage,
} from '../browser/activeWebviewReader'
import {
  buildReplaceMatchErrorHint,
  materializeTextEditPlan,
  recoverLikelyEscapedBackslashSequences,
} from '../edits/textEditEngine'
import {
  type MemoryScope,
  memoryAdd,
  memoryDelete,
  memoryUpdate,
} from '../memory/memoryManager'
import { isWithinYoloUserDataRoot } from '../paths/yoloPaths'
import type { RAGEngine } from '../rag/ragEngine'
import { acquireRuntimeComponent } from '../runtime-components/runtimeComponentAccess'
import { getLiteSkillDocumentByPath } from '../skills/liteSkills'
import {
  getContextPrunableToolCallIds,
  getContextPruneMode,
} from '../tools/context_prune_tool_results/helpers'
import {
  buildFileChangeSummary,
  maybeWithInternalWrite,
} from '../tools/file-editing-support'
import {
  MAX_EDIT_FILE_SIZE_BYTES,
  buildFsEditRejectedReason,
  buildFsEditReviewPayload,
  getFsEditPlan,
  getFsEditSelectionRange,
  waitForFsEditReview,
} from '../tools/fs_edit/schema-helpers'
import {
  type FsReadOperation,
  MAX_BATCH_READ_FILES,
  MAX_READ_MAX_LINES,
  OFFICE_READ_MAX_BYTES,
  getFsReadOperation,
  getOfficeDocumentKindFromExtension,
  isBrowserReadPath,
  normalizeFsReadPath,
  parseBrowserReadPageId,
  sliceLinesForFsReadOperation,
} from '../tools/fs_read/schema-helpers'
import {
  LOAD_TOOL_SCHEMAS_TOOL_NAME as LOAD_TOOL_SCHEMAS_LOCAL_TOOL_NAME,
  getLoadToolSchemasTool,
} from '../tools/internal/load_tool_schemas/definition'
import { invokeMemoryTool } from '../tools/memory-tool-support'
import {
  type BuiltinToolName,
  assertNoDuplicates,
  getToolDefinition,
  listBuiltinTools,
} from '../tools/registry'
import { enforceBuiltinToolSecurityBoundary } from '../tools/security-boundary'
import {
  MAX_FILE_SIZE_BYTES,
  asErrorMessage,
  formatJsonResult,
  getOptionalBoundedIntegerArg,
  getOptionalTextArg,
  getRecordArrayArg,
  getStringArrayArg,
  getTextArg,
} from '../tools/tool-args'
import type {
  LocalToolCallResult,
  LocalToolCallResultMetadata,
  ToolCatalogContext,
} from '../tools/types'
import {
  WEB_SCRAPE_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  runWebScrape,
  runWebSearch,
} from '../web-search'

import { getJsSandboxSettings } from './jsSandboxSettings'
import {
  JS_SANDBOX_TOOL_NAME,
  buildJsSandboxProxyHandlers,
  callJsSandboxTool,
} from './jsSandboxTool'
import { LOCAL_FILE_TOOL_SERVER } from './localFileToolNames'
import { parseToolName } from './tool-name-utils'
import { ensureParentFolderExists, validateVaultPath } from './vaultFileOps'

export { getLocalFileToolServerName } from './localFileToolNames'

export { recoverLikelyEscapedBackslashSequences }

export const TERMINAL_COMMAND_TOOL_NAME = 'terminal_command'
export const BASH_TOOL_NAME = 'bash'

export const LOCAL_FILE_TOOL_SHORT_NAMES = [
  BASH_TOOL_NAME,
  'context_prune_tool_results',
  'context_compact',
  'fs_read',
  'fs_edit',
  'fs_write',
  'memory_add',
  'memory_update',
  'memory_delete',
  'web_search',
  'web_scrape',
  JS_SANDBOX_TOOL_NAME,
  TERMINAL_COMMAND_TOOL_NAME,
  'delegate_subagent',
  'load_tool_schemas',
  'todo_write',
  'ask_user_question',
] as const

/**
 * Subset of {@link LOCAL_FILE_TOOL_SHORT_NAMES} that the user actually
 * configures via the Agent settings panel. `load_tool_schemas` is a protocol
 * tool — it exists for the on-demand disclosure mechanism, not as a user-
 * facing capability — so it is excluded here. The runtime still dispatches and
 * normalizes it through `LOCAL_FILE_TOOL_SHORT_NAMES`; it just isn't part of
 * the per-agent tool preference surface.
 */
export const USER_FACING_LOCAL_TOOL_SHORT_NAMES: readonly string[] =
  LOCAL_FILE_TOOL_SHORT_NAMES.filter((name) => name !== 'load_tool_schemas')
type LocalFileToolName = (typeof LOCAL_FILE_TOOL_SHORT_NAMES)[number]
// 'delete' | 'create_dir' | 'move' retired with fs_delete/fs_create_dir/fs_move
// (see the bash tool, which now covers path operations via vaultFileOps.ts).
type FsFileOpAction = 'write'

type FsResultItem = {
  ok: boolean
  action: FsFileOpAction
  target: string
  message: string
}

const LOCAL_FS_SPLIT_ACTION_TOOL_TO_ACTION = {
  fs_write: 'write',
} as const

export const LOCAL_FS_SPLIT_ACTION_TOOL_NAMES = Object.keys(
  LOCAL_FS_SPLIT_ACTION_TOOL_TO_ACTION,
) as Array<keyof typeof LOCAL_FS_SPLIT_ACTION_TOOL_TO_ACTION>

export const LOCAL_FS_EDIT_TOOL_NAMES = ['fs_edit', 'fs_write'] as const

export const LOCAL_MEMORY_SPLIT_ACTION_TOOL_NAMES = [
  'memory_add',
  'memory_update',
  'memory_delete',
] as const

const LOCAL_FS_WRITE_TOOL_NAMES = new Set<string>([
  'fs_edit',
  ...LOCAL_FS_SPLIT_ACTION_TOOL_NAMES,
  'memory_add',
  'memory_update',
  'memory_delete',
])

/**
 * Re-exported for external callers (`core/agent/tool-selection.ts`,
 * `core/agent/tool-preferences.ts`, `core/agent/tool-gateway.ts`) — the
 * implementation moved to `core/tools/internal/load_tool_schemas/definition.ts`
 * (D6b: it is a protocol-internal tool, not a `CAPABILITIES` member, so it
 * lives in `internal/` rather than getting a `defineTool` entry — see that
 * module's own doc comment). This is a plain re-export, not a registry
 * lookup (master.md §3.5: compat exports may only forward a per-tool
 * module's own constant, never round-trip through the registry).
 */
export { LOAD_TOOL_SCHEMAS_LOCAL_TOOL_NAME, getLoadToolSchemasTool }

/**
 * Model-facing catalog order, preserved verbatim from the pre-D6b literal
 * array this function used to return directly (phase2-migration.md D6b —
 * "顺序与内容逐条不变": the model's tool list must not silently reorder).
 * Every registered `BuiltinToolName` must appear here exactly once; the
 * module-load assertions below turn "forgot to add the new tool here" into
 * an immediate throw instead of a silently incomplete catalog.
 */
const LOCAL_FILE_TOOL_CATALOG_ORDER: readonly BuiltinToolName[] = [
  'context_prune_tool_results',
  'context_compact',
  'fs_read',
  'fs_edit',
  'fs_write',
  BASH_TOOL_NAME,
  'memory_add',
  'memory_update',
  'memory_delete',
  WEB_SEARCH_TOOL_NAME,
  WEB_SCRAPE_TOOL_NAME,
  JS_SANDBOX_TOOL_NAME,
  TERMINAL_COMMAND_TOOL_NAME,
  'delegate_subagent',
  'ask_user_question',
  'todo_write',
]

assertNoDuplicates(
  LOCAL_FILE_TOOL_CATALOG_ORDER,
  'local file tool catalog order entry',
)
if (
  LOCAL_FILE_TOOL_CATALOG_ORDER.length !== listBuiltinTools().length ||
  listBuiltinTools().some(
    (tool) =>
      !(LOCAL_FILE_TOOL_CATALOG_ORDER as readonly string[]).includes(tool.name),
  )
) {
  throw new Error(
    'getLocalFileTools() catalog order is out of sync with the built-in tool registry (core/tools/registry.ts) — add the missing tool name to LOCAL_FILE_TOOL_CATALOG_ORDER.',
  )
}

export function getLocalFileTools(options?: {
  vaultBasePath?: string
  chatModelModalities?: ChatModelModality[]
}): McpTool[] {
  const catalogCtx: ToolCatalogContext = {
    vaultBasePath: options?.vaultBasePath,
    chatModelModalities: options?.chatModelModalities,
  }
  return LOCAL_FILE_TOOL_CATALOG_ORDER.filter((name) => {
    // `bash`'s catalog-inclusion is gated by the `bash-engine` runtime
    // component being enabled — the one tool whose presence here was ever
    // conditional (see the pre-D6b literal array this replaced). That
    // judgment now lives on the tool's own `isAvailable`
    // (`core/tools/bash/definition.ts`) rather than a raw
    // `isRuntimeComponentEnabled` call inline here, but this loop still has
    // to consult it explicitly per-tool rather than applying `isAvailable`
    // uniformly to every entry: `ToolCatalogContext` carries no `settings`
    // snapshot, so a uniform pass would silently drop `web_search` (whose
    // `isAvailable` needs `settings`) from every catalog built here —
    // including the settings-page call sites (`AgentSection.tsx`,
    // `AgentToolsModal.tsx`, `agentToolPersistence.ts`) that need the full,
    // unfiltered list to render toggles regardless of runtime readiness
    // (master.md decision 18). `web_search` / `terminal_command` /
    // `js_eval` stay unconditionally listed here, exactly as before;
    // environment-availability filtering for *them* happens downstream, in
    // `McpManager.isLocalToolEnabled` (`core/mcp/mcpManager.ts`), which
    // already calls every registered tool's `isAvailable` generically once
    // real `settings` are available.
    if (name !== BASH_TOOL_NAME) return true
    const definition = getToolDefinition(name)
    return definition?.isAvailable ? definition.isAvailable({}) : true
  }).map((name) => {
    const definition = getToolDefinition(name)
    if (!definition) {
      throw new Error(`Unknown built-in tool "${name}" in catalog order`)
    }
    return { name, ...definition.getMcpTool(catalogCtx) }
  })
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

const assertContentSize = (content: string): void => {
  if (content.length > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `Content too large (${content.length} chars). Max allowed is ${MAX_FILE_SIZE_BYTES}.`,
    )
  }
}

const normalizeLocalToolName = (toolName: string): string => {
  if (!toolName.includes('__')) {
    return toolName
  }
  const parts = toolName.split('__')
  return parts[parts.length - 1] ?? toolName
}

export function isLocalFsWriteToolName(toolName: string): boolean {
  return LOCAL_FS_WRITE_TOOL_NAMES.has(normalizeLocalToolName(toolName))
}

export const ASK_USER_QUESTION_TOOL_NAME = 'ask_user_question'

export type AskUserQuestionInputType =
  | 'free_text'
  | 'single_select'
  | 'multi_select'

export type AskUserQuestionOption = {
  id: string
  label: string
}

/**
 * Reserved option id used by the UI to inject an "Other" escape hatch into
 * every single_select / multi_select. The model is forbidden from emitting an
 * option with this id (the validator rejects it) so the UI can rely on the id
 * being free.
 */
export const ASK_USER_QUESTION_OTHER_ID = '__other__'

export type AskUserQuestionItem = {
  id: string
  prompt: string
  inputType: AskUserQuestionInputType
  options?: AskUserQuestionOption[]
}

export type AskUserQuestionArgs = {
  questions: AskUserQuestionItem[]
}

export type AskUserQuestionValidationResult =
  | { ok: true; value: AskUserQuestionArgs }
  | { ok: false; error: string }

/**
 * Validate the model-provided arguments for the `ask_user_question` tool.
 * The tool has no execution path — the gateway calls this and converts a
 * failed result into a Tool Error response. A successful result is what the
 * UI panel renders.
 */
export function validateAskUserQuestionArgs(
  rawArgs: unknown,
): AskUserQuestionValidationResult {
  if (
    rawArgs === null ||
    typeof rawArgs !== 'object' ||
    Array.isArray(rawArgs)
  ) {
    return { ok: false, error: 'arguments must be an object.' }
  }
  const args = rawArgs as Record<string, unknown>
  const rawQuestions = args.questions
  if (!Array.isArray(rawQuestions)) {
    return { ok: false, error: 'questions must be an array.' }
  }
  if (rawQuestions.length < 1) {
    return {
      ok: false,
      error: 'questions must contain at least 1 item.',
    }
  }

  const seenIds = new Set<string>()
  const validated: AskUserQuestionItem[] = []
  for (let i = 0; i < rawQuestions.length; i++) {
    const raw = rawQuestions[i]
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: `questions[${i}] must be an object.` }
    }
    const q = raw as Record<string, unknown>

    const id = q.id
    if (typeof id !== 'string' || id.trim() === '') {
      return {
        ok: false,
        error: `questions[${i}].id must be a non-empty string.`,
      }
    }
    if (seenIds.has(id)) {
      return {
        ok: false,
        error: `questions[${i}].id "${id}" is duplicated; ids must be unique.`,
      }
    }
    seenIds.add(id)

    const prompt = q.prompt
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      return {
        ok: false,
        error: `questions[${i}].prompt must be a non-empty string.`,
      }
    }

    const inputType = q.inputType
    if (
      inputType !== 'free_text' &&
      inputType !== 'single_select' &&
      inputType !== 'multi_select'
    ) {
      return {
        ok: false,
        error: `questions[${i}].inputType must be "free_text", "single_select", or "multi_select".`,
      }
    }

    let options: AskUserQuestionOption[] | undefined

    if (inputType === 'single_select' || inputType === 'multi_select') {
      if (!Array.isArray(q.options)) {
        return {
          ok: false,
          error: `questions[${i}].options must be an array for ${inputType}.`,
        }
      }
      if (q.options.length < 2) {
        return {
          ok: false,
          error: `questions[${i}].options must contain at least 2 items.`,
        }
      }
      const seenOptionIds = new Set<string>()
      const opts: AskUserQuestionOption[] = []
      for (let j = 0; j < q.options.length; j++) {
        const rawOpt = q.options[j]
        if (
          rawOpt === null ||
          typeof rawOpt !== 'object' ||
          Array.isArray(rawOpt)
        ) {
          return {
            ok: false,
            error: `questions[${i}].options[${j}] must be an object.`,
          }
        }
        const opt = rawOpt as Record<string, unknown>
        if (typeof opt.id !== 'string' || opt.id.trim() === '') {
          return {
            ok: false,
            error: `questions[${i}].options[${j}].id must be a non-empty string.`,
          }
        }
        if (opt.id === ASK_USER_QUESTION_OTHER_ID) {
          return {
            ok: false,
            error: `questions[${i}].options[${j}].id "${ASK_USER_QUESTION_OTHER_ID}" is reserved by the UI; remove this option and rely on the auto-appended "Other" entry.`,
          }
        }
        if (typeof opt.label !== 'string' || opt.label.trim() === '') {
          return {
            ok: false,
            error: `questions[${i}].options[${j}].label must be a non-empty string.`,
          }
        }
        if (seenOptionIds.has(opt.id)) {
          return {
            ok: false,
            error: `questions[${i}].options[${j}].id "${opt.id}" is duplicated within the question.`,
          }
        }
        seenOptionIds.add(opt.id)
        opts.push({ id: opt.id, label: opt.label })
      }
      options = opts
    } else {
      // free_text
      if (q.options !== undefined) {
        return {
          ok: false,
          error: `questions[${i}].options is not allowed for free_text inputType.`,
        }
      }
    }

    validated.push({
      id,
      prompt,
      inputType,
      ...(options ? { options } : {}),
    })
  }

  return { ok: true, value: { questions: validated } }
}

export function isAskUserQuestionToolName(toolName: string): boolean {
  try {
    const parsed = parseToolName(toolName)
    return (
      parsed.serverName === LOCAL_FILE_TOOL_SERVER &&
      parsed.toolName === ASK_USER_QUESTION_TOOL_NAME
    )
  } catch {
    return false
  }
}

export function parseLocalFsActionFromToolArgs({
  toolName,
  args: _args,
}: {
  toolName: string
  args?: Record<string, unknown> | string
}): FsFileOpAction | null {
  const normalizedToolName = normalizeLocalToolName(toolName)
  const splitAction =
    LOCAL_FS_SPLIT_ACTION_TOOL_TO_ACTION[
      normalizedToolName as keyof typeof LOCAL_FS_SPLIT_ACTION_TOOL_TO_ACTION
    ]
  if (splitAction) {
    return splitAction
  }
  return null
}

const executeFsFileOps = async ({
  app,
  settings,
  action,
  item,
  signal,
  tool,
  conversationId,
  roundId,
  toolCallId,
}: {
  app: App
  settings?: YoloSettings
  action: FsFileOpAction
  item: Record<string, unknown>
  signal?: AbortSignal
  tool: string
  conversationId?: string
  roundId?: string
  toolCallId?: string
}): Promise<LocalToolCallResult> => {
  if (signal?.aborted) {
    return { status: ToolCallResponseStatus.Aborted }
  }

  const appliedAt = Date.now()

  try {
    if (action === 'write') {
      const path = validateVaultPath(getTextArg(item, 'path'))
      const content = getTextArg(item, 'content')
      assertContentSize(content)

      const existing = app.vault.getAbstractFileByPath(path)

      if (existing instanceof TFolder) {
        throw new Error(`Path is a folder, cannot overwrite as a file: ${path}`)
      }

      let result: FsResultItem
      let metadata: LocalToolCallResultMetadata | undefined

      if (existing instanceof TFile) {
        // Overwrite. Guard against pulling an oversized old file into the
        // diff/undo snapshot: when the existing content exceeds the size
        // limit we still overwrite, but skip the snapshot/editSummary so we
        // don't blow up memory with a giant before-content.
        const overSized = existing.stat.size > MAX_FILE_SIZE_BYTES
        const beforeContent = overSized ? '' : await app.vault.read(existing)
        await app.vault.modify(existing, content)
        if (!overSized) {
          metadata = await buildFileChangeSummary({
            app,
            settings,
            path,
            beforeContent,
            afterContent: content,
            beforeExists: true,
            afterExists: true,
            conversationId,
            roundId,
            toolCallId,
            appliedAt,
          })
        }
        result = {
          ok: true,
          action,
          target: path,
          message: overSized
            ? 'Overwrote file (existing content too large for undo snapshot).'
            : 'Overwrote file.',
        }
      } else {
        await ensureParentFolderExists(app, path)
        await app.vault.create(path, content)
        metadata = await buildFileChangeSummary({
          app,
          settings,
          path,
          beforeContent: '',
          afterContent: content,
          beforeExists: false,
          afterExists: true,
          conversationId,
          roundId,
          toolCallId,
          appliedAt,
        })
        result = {
          ok: true,
          action,
          target: path,
          message: 'Created file.',
        }
      }

      return {
        status: ToolCallResponseStatus.Success,
        text: formatJsonResult({ tool, action, results: [result] }),
        metadata,
      }
    }

    throw new Error(`Unsupported fs action: ${action}`)
  } catch (error) {
    return {
      status: ToolCallResponseStatus.Error,
      error: asErrorMessage(error),
    }
  }
}

export async function callLocalFileTool({
  app,
  settings,
  openApplyReview,
  getRagEngine,
  conversationId,
  conversationMessages,
  roundId,
  toolCallId,
  toolName,
  args,
  requireReview = false,
  signal,
  chatModelId,
  workspaceScope,
  allowedSkillPaths,
  // Unused in this file now that fs_search (citation annotation) — its only
  // consumer — is gone. Kept in the accepted options shape because callers
  // still pass it uniformly regardless of which tool is being invoked.
  runContext: _runContext,
  subagentParentContext,
  promptSourceWatcher,
  bashApprovalMode,
  bashReadOnly,
}: {
  app: App
  settings?: YoloSettings
  openApplyReview?: (state: ApplyViewState) => Promise<boolean>
  getRagEngine?: () => Promise<RAGEngine>
  conversationId?: string
  conversationMessages?: ChatMessage[]
  roundId?: string
  toolCallId?: string
  toolName: string
  args: Record<string, unknown>
  requireReview?: boolean
  signal?: AbortSignal
  chatModelId?: string
  workspaceScope?: AssistantWorkspaceScope
  allowedSkillPaths?: readonly string[]
  runContext?: AgentRunContext
  subagentParentContext?: SubagentParentContext
  promptSourceWatcher?: PromptSourceWatcher
  /** Effective approval tier for the bash tool (see tool-gateway.ts). */
  bashApprovalMode?: AssistantToolApprovalMode
  /**
   * Forces the bash tool call into its structurally read-only variant for
   * this entire run (see tool-gateway.ts). When true, mkdir/mv/rm/rmdir are
   * unavailable regardless of `bashApprovalMode`.
   */
  bashReadOnly?: boolean
}): Promise<LocalToolCallResult> {
  if (signal?.aborted) {
    return { status: ToolCallResponseStatus.Aborted }
  }

  try {
    // Two safety-critical checks (workspace scope, YOLO user-data-root
    // isolation) that must run unconditionally ahead of every tool body,
    // including manual-approval / direct-call paths. Shared verbatim with
    // `src/core/tools/dispatcher.ts` — see that module's doc comment for why
    // this is a single implementation rather than two that could drift.
    enforceBuiltinToolSecurityBoundary(toolName, args, {
      settings,
      workspaceScope,
      allowedSkillPaths,
    })

    const name = toolName as LocalFileToolName
    switch (name) {
      // 'context_prune_tool_results' and 'context_compact' below are now
      // unreachable in practice — both are registered in `CAPABILITIES`
      // (`src/core/tools/capabilities/index.ts`), so the delegation bridge
      // above routes them to `executeBuiltinTool` before this switch is ever
      // reached. Left in place rather than deleted, matching the precedent
      // set by the still-present `memory_add`/`memory_update`/
      // `memory_delete`/`delegate_subagent` cases below (D2/D3): tearing
      // down this switch is a later-phase concern (master.md D6 "注意" /
      // D7), not this batch's.
      case 'context_prune_tool_results': {
        const mode = getContextPruneMode(args)

        const prunableToolCallIds = getContextPrunableToolCallIds(
          conversationMessages,
          toolCallId,
        )
        const toolCallIds =
          mode === 'all'
            ? [...prunableToolCallIds]
            : getStringArrayArg(args, 'toolCallIds')
                .map((value) => value.trim())
                .filter(
                  (value, index, arr) =>
                    value.length > 0 && arr.indexOf(value) === index,
                )

        if (mode === 'selected' && toolCallIds.length === 0) {
          throw new Error('toolCallIds cannot be empty when mode is selected.')
        }

        const acceptedToolCallIds = toolCallIds.filter((value) =>
          prunableToolCallIds.has(value),
        )
        const ignoredToolCallIds = toolCallIds.filter(
          (value) => !prunableToolCallIds.has(value),
        )

        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult({
            tool: 'context_prune_tool_results',
            toolCallId: toolCallId ?? null,
            operation: mode === 'all' ? 'prune_all' : 'prune_selected',
            acceptedToolCallIds,
            ignoredToolCallIds,
            reason: getOptionalTextArg(args, 'reason')?.trim() || null,
          }),
        }
      }

      case 'context_compact': {
        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult({
            tool: 'context_compact',
            toolCallId: toolCallId ?? null,
            operation: 'compact_restart',
            reason: getOptionalTextArg(args, 'reason')?.trim() || null,
            instruction:
              getOptionalTextArg(args, 'instruction')?.trim() || null,
          }),
        }
      }

      case 'fs_read': {
        const paths = getStringArrayArg(args, 'paths')
          .map((path) => normalizeFsReadPath(path))
          .filter((path, index, arr) => arr.indexOf(path) === index)

        if (paths.length === 0) {
          throw new Error('paths cannot be empty.')
        }
        if (paths.length > MAX_BATCH_READ_FILES) {
          throw new Error(
            `paths supports up to ${MAX_BATCH_READ_FILES} files per call.`,
          )
        }
        const operation = getFsReadOperation(args)
        // Resolution context for wikilink-style path entries (see the
        // fallback resolution below). Not a path read from — just the
        // linking note's path, mirroring how Obsidian resolves real
        // wikilinks. Not subject to workspace-scope checks itself.
        const rawSourcePath = getOptionalTextArg(args, 'sourcePath')?.trim()
        const sourcePath =
          rawSourcePath && rawSourcePath.length > 0
            ? validateVaultPath(rawSourcePath)
            : undefined
        const allowedSkillPathSet = allowedSkillPaths
          ? buildAllowedSkillPathSet(allowedSkillPaths)
          : undefined

        const results: Array<
          | {
              path: string
              ok: true
              totalLines: number
              returnedRange?: {
                startLine: number | null
                endLine: number | null
              }
              hasMoreBelow: boolean
              nextStartLine: number | null
              content: string
              wikilinks?: Array<{ link: string; path: string }>
              effectiveModality?: 'text' | 'image' | 'pdf'
              warning?: string
              url?: string
              title?: string
              loading?: boolean
              redactions?: Array<{ kind: string; count: number }>
              partial?: { reason: string; message: string }
              // Present when this entry was resolved via wikilink fallback
              // rather than an exact vault path match (see the resolution
              // loop below).
              resolvedPath?: string
              resolvedSubpath?: WikilinkReadSubpath
            }
          | {
              path: string
              ok: false
              error: string
            }
        > = []
        const readSkillNames: string[] = []

        // Tool result attachments hoisted to a follow-up user message after
        // the tool block. Mostly image_url for rendered PDFs/images, but also
        // `document` for native PDF slices.
        const perFileAttachmentParts: Array<{
          path: string
          parts: ContentPart[]
        }> = []

        // Skip image extraction when the active chat model does not accept
        // vision input; otherwise we'd ship base64 payloads to a text-only
        // endpoint and get a 400 back (issue #255). Migration 48→49 backfills
        // `modalities` on every ChatModel, so a missing array here means we
        // either have no active model or the lookup failed — treat as allow.
        const activeChatModel =
          chatModelId && settings?.chatModels
            ? (settings.chatModels.find((m) => m.id === chatModelId) ?? null)
            : null
        const chatModelAcceptsImages = activeChatModel
          ? chatModelSupportsVision(activeChatModel)
          : true
        // Conservative: when no active model is known, don't assume PDF support.
        const chatModelAcceptsPdf = activeChatModel
          ? chatModelSupportsPdf(activeChatModel)
          : false

        for (const path of paths) {
          if (signal?.aborted) {
            return { status: ToolCallResponseStatus.Aborted }
          }

          if (allowedSkillPathSet?.has(normalizeSkillPathForExemption(path))) {
            const skillDocument = await getLiteSkillDocumentByPath({
              app,
              path,
              settings,
            })
            if (!skillDocument) {
              results.push({ path, ok: false, error: 'Skill not found.' })
              continue
            }

            const content = skillDocument.content
            const lines = content.length === 0 ? [] : content.split('\n')
            const sliced = sliceLinesForFsReadOperation(lines, operation)

            results.push({
              path,
              ok: true,
              totalLines: sliced.totalLines,
              returnedRange:
                operation.type === 'lines'
                  ? {
                      startLine: sliced.returnedStartLine,
                      endLine: sliced.returnedEndLine,
                    }
                  : undefined,
              hasMoreBelow: sliced.hasMoreBelow,
              nextStartLine: sliced.nextStartLine,
              content: sliced.outputContent,
            })
            readSkillNames.push(skillDocument.entry.name)
            continue
          }

          if (isBrowserReadPath(path)) {
            if (Platform.isMobile) {
              results.push({
                path,
                ok: false,
                error: 'Reading open web pages via fs_read is desktop-only.',
              })
              continue
            }

            const pageId = parseBrowserReadPageId(path)
            const handle = findWebviewHandleByPageId(app, pageId)
            if (!handle) {
              results.push({
                path,
                ok: false,
                error: `No open web page with page_id "${pageId}" was found. The tab may have been closed or replaced.`,
              })
              continue
            }

            const format = operation.format ?? 'key_visible_info'
            try {
              const browserResult = await readActiveWebviewPage(handle, {
                format,
                signal,
              })
              if (!browserResult) {
                results.push({
                  path,
                  ok: false,
                  error:
                    'Webview is present but has no loaded page (URL empty or about:blank). Navigate to a URL first.',
                })
                continue
              }

              const text = browserResult.text ?? ''
              const lines = text.length === 0 ? [] : text.split('\n')
              const sliced = sliceLinesForFsReadOperation(lines, operation)
              results.push({
                path,
                ok: true,
                totalLines: sliced.totalLines,
                returnedRange:
                  operation.type === 'lines'
                    ? {
                        startLine: sliced.returnedStartLine,
                        endLine: sliced.returnedEndLine,
                      }
                    : undefined,
                hasMoreBelow: sliced.hasMoreBelow,
                nextStartLine: sliced.nextStartLine,
                content: sliced.outputContent,
                url: browserResult.url,
                title: browserResult.title,
                loading: browserResult.loading,
                redactions: browserResult.redactions,
                ...(browserResult.partial
                  ? { partial: browserResult.partial }
                  : {}),
              })
            } catch (error) {
              if (error instanceof BrowserReadFailure) {
                results.push({
                  path,
                  ok: false,
                  error: `${error.code}: ${error.message}`,
                })
                continue
              }
              throw error
            }
            continue
          }

          // Exact vault path first (unchanged from prior behavior). Only on
          // a miss do we try wikilink resolution — an explicit `[[...]]`
          // wrapper can never be a valid exact path, and Obsidian filenames
          // can't contain '#', so subpathed links can't collide with exact
          // paths either.
          let file = app.vault.getFileByPath(path)
          let resolvedPath: string | undefined
          let resolvedSubpath: WikilinkReadSubpath | undefined
          let subpathWarning: string | undefined

          if (!file) {
            const target = resolveWikilinkReadTarget(app, path, sourcePath)
            if (!target) {
              results.push({
                path,
                ok: false,
                error: `File not found. "${path}" did not match a vault path or a resolvable wikilink target.`,
              })
              continue
            }
            file = target.file
            resolvedPath = file.path
            if (target.subpath) {
              resolvedSubpath = target.subpath
            } else if (target.subpathError) {
              subpathWarning = target.subpathError
            }
          }

          // The YOLO user-data root (`<baseDir>/data`: chat history, module
          // settings/intent) must stay invisible to agent tools exactly like
          // its hidden pre-migration location (`.yolo_json_db`) was — see
          // `ensureUserDataRootDir` in `core/paths/yoloManagedData.ts`. Dot
          // directories were never indexed into the `TFile` tree at all, so
          // this exact-match/wikilink resolution above could never have hit
          // them; this check reproduces that invisibility explicitly now
          // that the root is visible. Reported as a plain not-found — same
          // wording as a genuine miss — so no new information ("this path is
          // specially hidden") leaks to the model. Checked before the
          // workspace-scope gate so it applies unconditionally, regardless
          // of whether workspace scope is even enabled.
          if (isWithinYoloUserDataRoot(file.path, settings)) {
            results.push({
              path,
              ok: false,
              error: `File not found: "${path}".`,
            })
            continue
          }

          // Scope enforcement for fs_read lives here rather than in the
          // top-level raw-string check (see workspaceScope.ts) because
          // wikilink targets aren't literal paths until resolved above.
          // Applies uniformly to exact-match and wikilink-resolved entries.
          // Files inside an allowed skill package keep the same exemption
          // they had under findPathOutsideScope's exemptPaths option.
          if (
            workspaceScope?.enabled &&
            !isPathAllowedByScope(file.path, workspaceScope) &&
            !(
              allowedSkillPathSet &&
              isCoveredBySkillPathExemption(file.path, allowedSkillPathSet)
            )
          ) {
            results.push({
              path,
              ok: false,
              error: `Path "${file.path}" is outside this agent's workspace scope.`,
            })
            continue
          }

          const wikilinkResultFields: {
            resolvedPath?: string
            resolvedSubpath?: WikilinkReadSubpath
          } = resolvedPath
            ? {
                resolvedPath,
                ...(resolvedSubpath ? { resolvedSubpath } : {}),
              }
            : {}

          const isPdf = file.extension?.toLowerCase() === 'pdf'
          if (isPdf) {
            if (file.stat.size > PDF_INDEX_MAX_BYTES) {
              results.push({
                path,
                ok: false,
                error: `PDF too large (${file.stat.size} bytes).`,
              })
              continue
            }

            // Resolve the effective modality for this PDF read. The schema
            // exposed to the model is tailored per capability (see
            // buildFsReadModalitySchema), so normally the requested modality
            // is already aligned with what the model can use. The branches
            // below also handle the "out-of-schema" cases (model somehow
            // sends image to a PDF-capable model, or pdf to a vision-only
            // model) — those resolve to the strictly-better alternative
            // rather than failing.
            //
            // Decision table:
            //   ── PDF-capable model ──
            //     undefined → pdf
            //     'pdf'     → pdf
            //     'text'    → text  (cheap path; respected verbatim)
            //     'image'   → pdf   (image is redundant when native PDF is
            //                       available — native PDF is strictly more
            //                       informative; this branch is a safety net,
            //                       schema doesn't expose image to these
            //                       models)
            //   ── vision-capable (non-PDF) ──
            //     undefined → text
            //     'pdf'     → text  (pdf not supported; safety-net downgrade)
            //     'text'    → text
            //     'image'   → image if image-read setting enabled, else text
            //   ── text-only ──
            //     all paths → text (no other modality is supported)
            const imageReadingEnabled =
              settings?.chatOptions?.imageReadingEnabled ?? true
            const canUseImage = chatModelAcceptsImages && imageReadingEnabled
            const resolvedModality: 'pdf' | 'image' | 'text' = (() => {
              if (chatModelAcceptsPdf) {
                switch (operation.modality) {
                  case undefined:
                  case 'pdf':
                  case 'image':
                    return 'pdf'
                  case 'text':
                    return 'text'
                }
              }
              switch (operation.modality) {
                case undefined:
                case 'pdf':
                case 'text':
                  return 'text'
                case 'image':
                  return canUseImage ? 'image' : 'text'
              }
            })()

            // ── Native PDF slice branch ────────────────────────────────────
            if (resolvedModality === 'pdf') {
              const reqStart =
                operation.type === 'lines' ? operation.startLine : 1
              // 范围读取显式给 maxLines 时按页数计算；未给 endLine/maxLines
              // 时保留低成本探查语义，只读 startLine 对应的单页。
              // full 模式的 endPage 留空，由 slicePdfPages 自动取到文档末页。
              const reqEnd =
                operation.type === 'lines'
                  ? (operation.endLine ??
                    (operation.maxLines !== undefined
                      ? operation.startLine + operation.maxLines - 1
                      : operation.startLine))
                  : undefined

              // Attempt to slice the PDF. slicePdfPages loads the source once
              // and reports total page count + clamped range; on failure it
              // throws a tagged PdfSliceError. Caller-side reaction depends on
              // the kind:
              //   • 'invalid-range' (e.g. startPage > totalPages) is a hard
              //     model-facing error — degrading to text would silently hide
              //     a bad page request.
              //   • all other kinds (load-failed / too-large / too-many-pages)
              //     fall through to text extraction with a warning prefix.
              let sliceResult:
                | Awaited<ReturnType<typeof slicePdfPages>>
                | undefined
              let sliceFallbackWarning: string | undefined

              try {
                const rawBuf = await app.vault.readBinary(file)
                const rawBytes = new Uint8Array(rawBuf)
                sliceResult = await slicePdfPages(rawBytes, {
                  startPage: reqStart,
                  endPage: reqEnd,
                })
              } catch (err) {
                if (
                  err instanceof PdfSliceError &&
                  err.kind === 'invalid-range'
                ) {
                  results.push({
                    path,
                    ok: false,
                    error: err.message,
                  })
                  continue
                }
                sliceFallbackWarning =
                  err instanceof Error ? err.message : String(err)
              }

              if (sliceResult !== undefined) {
                // Slice succeeded — emit the document part.
                const {
                  bytes: slicedBytes,
                  totalSourcePages,
                  actualStart,
                  actualEnd,
                } = sliceResult
                const slicePageCount = actualEnd - actualStart + 1

                const base64Data = uint8ArrayToBase64(slicedBytes)
                const documentPart: ContentPart = {
                  type: 'document',
                  mediaType: 'application/pdf',
                  name: `${file.name} (pages ${actualStart}–${actualEnd})`,
                  data: base64Data,
                  pageCount: slicePageCount,
                }

                const hasMoreBelow =
                  operation.type === 'lines' && actualEnd < totalSourcePages
                const nextStartLine = hasMoreBelow ? actualEnd + 1 : null

                results.push({
                  path,
                  ok: true,
                  totalLines: totalSourcePages,
                  returnedRange:
                    operation.type === 'lines'
                      ? { startLine: actualStart, endLine: actualEnd }
                      : undefined,
                  hasMoreBelow,
                  nextStartLine,
                  // Explain page-number renumbering so the model cites original
                  // page numbers (actualStart–actualEnd) rather than the
                  // slice-internal numbers (1–slicePageCount).
                  content: `Read pages ${actualStart}–${actualEnd} of "${file.name}" (original document has ${totalSourcePages} pages).\nThe attached PDF slice contains those pages renumbered as 1–${slicePageCount} internally, but you should refer to them by their ORIGINAL page numbers (${actualStart}–${actualEnd}) when citing.`,
                  effectiveModality: 'pdf' as const,
                  ...wikilinkResultFields,
                  ...(subpathWarning ? { warning: subpathWarning } : {}),
                })
                perFileAttachmentParts.push({ path, parts: [documentPart] })
                continue
              }

              // Slice failed — fall through to text extraction with a warning prefix.
              let pdfSliceFallbackPages: { page: number; text: string }[] = []
              try {
                const extracted = await extractPdfText(app, file, {
                  signal,
                  maxBinaryBytes: PDF_INDEX_MAX_BYTES,
                  maxPages: PDF_INDEX_MAX_PAGES,
                  settings,
                })
                pdfSliceFallbackPages = extracted.pages
              } catch (extractErr) {
                if (
                  extractErr instanceof DOMException &&
                  extractErr.name === 'AbortError'
                ) {
                  return { status: ToolCallResponseStatus.Aborted }
                }
                results.push({
                  path,
                  ok: false,
                  error:
                    extractErr instanceof Error
                      ? extractErr.message
                      : 'Failed to extract PDF text.',
                })
                continue
              }

              const fbTotalPageCount = pdfSliceFallbackPages.length
              const fbRangeStart = operation.type === 'lines' ? reqStart : 1
              const fbRangeEnd =
                operation.type === 'full'
                  ? fbTotalPageCount
                  : Math.min(reqEnd ?? fbRangeStart, fbTotalPageCount)
              const fbSelectedPages = pdfSliceFallbackPages.filter(
                (p) => p.page >= fbRangeStart && p.page <= fbRangeEnd,
              )
              const fbTaggedBody = fbSelectedPages
                .map((p) => `<page ${p.page}>\n${p.text}\n</page ${p.page}>`)
                .join('\n')
              const fbWarningPrefix = `[PDF native slice failed for pages ${fbRangeStart}–${fbRangeEnd}, falling back to text extraction. Reason: ${sliceFallbackWarning ?? 'unknown error'}]\n\n`

              results.push({
                path,
                ok: true,
                totalLines: fbTotalPageCount,
                returnedRange:
                  operation.type === 'lines'
                    ? {
                        startLine:
                          fbSelectedPages.length > 0 ? fbRangeStart : null,
                        endLine: fbSelectedPages.length > 0 ? fbRangeEnd : null,
                      }
                    : undefined,
                hasMoreBelow:
                  operation.type === 'lines' && fbRangeEnd < fbTotalPageCount,
                nextStartLine:
                  operation.type === 'lines' && fbRangeEnd < fbTotalPageCount
                    ? fbRangeEnd + 1
                    : null,
                content: fbWarningPrefix + fbTaggedBody,
                effectiveModality: 'text' as const,
                warning: subpathWarning
                  ? `${fbWarningPrefix.trim()} ${subpathWarning}`
                  : fbWarningPrefix.trim(),
                ...wikilinkResultFields,
              })
              continue
            }

            // ── Image render branch ────────────────────────────────────────
            // resolvedModality has already taken vision capability and the
            // image-reading setting into account; checking it here is enough.
            if (resolvedModality === 'image') {
              // Mirror text-mode semantics where it makes sense:
              //   - `full`  → render every page (matches "full = whole file").
              //   - targeted read with maxLines → render that many pages.
              //   - targeted read without endLine/maxLines → render only
              //     startLine. This gives the model a cheap peek that returns
              //     totalPages before it asks for a precise range.
              const reqStart =
                operation.type === 'lines' ? operation.startLine : 1
              const reqEnd =
                operation.type === 'lines'
                  ? (operation.endLine ??
                    (operation.maxLines !== undefined
                      ? operation.startLine + operation.maxLines - 1
                      : operation.startLine))
                  : undefined

              let renderResult: Awaited<
                ReturnType<typeof renderPdfPagesToImages>
              >
              try {
                renderResult = await renderPdfPagesToImages(
                  app,
                  file,
                  reqStart,
                  reqEnd,
                  settings,
                )
              } catch (error) {
                results.push({
                  path,
                  ok: false,
                  error:
                    error instanceof Error
                      ? error.message
                      : 'Failed to render PDF pages as images.',
                })
                continue
              }

              const { totalPages, rendered } = renderResult
              const rangeStartPage = reqStart
              const rangeEndPageInclusive =
                reqEnd === undefined ? totalPages : Math.min(reqEnd, totalPages)
              const returnedCount = rendered.length
              const returnedStartLine =
                returnedCount > 0 ? rangeStartPage : null
              const returnedEndLine =
                returnedCount > 0 ? rangeEndPageInclusive : null
              const hasMoreBelow = rangeEndPageInclusive < totalPages
              const nextStartLine = hasMoreBelow
                ? rangeEndPageInclusive + 1
                : null

              results.push({
                path,
                ok: true,
                totalLines: totalPages,
                returnedRange: {
                  startLine: returnedStartLine,
                  endLine: returnedEndLine,
                },
                hasMoreBelow,
                nextStartLine,
                content: '',
                ...wikilinkResultFields,
                ...(subpathWarning ? { warning: subpathWarning } : {}),
              })

              if (rendered.length > 0) {
                perFileAttachmentParts.push({
                  path,
                  parts: rendered.map((r) => ({
                    type: 'image_url' as const,
                    image_url: {
                      url: r.dataUrl,
                      cacheKey: buildPdfPageImageCacheKey(
                        file.path,
                        file.stat.mtime,
                        file.stat.size,
                        r.page,
                      ),
                    },
                  })),
                })
              }
              continue
            }

            let pages: { page: number; text: string }[] = []
            try {
              const extracted = await extractPdfText(app, file, {
                signal,
                maxBinaryBytes: PDF_INDEX_MAX_BYTES,
                maxPages: PDF_INDEX_MAX_PAGES,
                settings,
              })
              pages = extracted.pages
            } catch (error) {
              if (
                error instanceof DOMException &&
                error.name === 'AbortError'
              ) {
                return { status: ToolCallResponseStatus.Aborted }
              }
              results.push({
                path,
                ok: false,
                error:
                  error instanceof Error
                    ? error.message
                    : 'Failed to extract PDF text.',
              })
              continue
            }

            const totalPageCount = pages.length
            let rangeStartPage = 1
            let rangeEndPageInclusive = totalPageCount
            if (operation.type === 'lines') {
              rangeStartPage = operation.startLine
              // PDF defaults to a single page when neither endLine nor
              // maxLines is provided — a PDF page carries far more content
              // than a markdown line. Explicit maxLines counts pages.
              rangeEndPageInclusive = Math.min(
                operation.endLine ??
                  (operation.maxLines !== undefined
                    ? rangeStartPage + operation.maxLines - 1
                    : rangeStartPage),
                totalPageCount,
              )
              if (rangeEndPageInclusive < rangeStartPage) {
                results.push({
                  path,
                  ok: false,
                  error: 'endLine must be greater than or equal to startLine.',
                })
                continue
              }
              if (
                rangeEndPageInclusive - rangeStartPage + 1 >
                MAX_READ_MAX_LINES
              ) {
                results.push({
                  path,
                  ok: false,
                  error: `Requested page range is too large. Maximum ${MAX_READ_MAX_LINES} pages per file.`,
                })
                continue
              }
            }

            const selectedPages = pages.filter(
              (p) =>
                p.page >= rangeStartPage && p.page <= rangeEndPageInclusive,
            )

            const taggedBody = selectedPages
              .map((p) => `<page ${p.page}>\n${p.text}\n</page ${p.page}>`)
              .join('\n')
            if (taggedBody.length > MAX_FILE_SIZE_BYTES) {
              results.push({
                path,
                ok: false,
                error: `Extracted PDF text too large (${taggedBody.length} chars). Max allowed is ${MAX_FILE_SIZE_BYTES}.`,
              })
              continue
            }

            // PDF 场景下 line 语义 = 页号。不做 `${index+1}|` 前缀，避免
            // 与 returnedRange（页号）语义错位，LLM 可直接依赖 <page N> 标签定位。
            const totalLines = totalPageCount
            const outputContent = taggedBody
            const returnedCount = selectedPages.length
            const returnedStartLine = returnedCount > 0 ? rangeStartPage : null
            const returnedEndLine =
              returnedCount > 0 ? rangeEndPageInclusive : null
            const hasMoreBelow =
              operation.type === 'lines' &&
              rangeEndPageInclusive < totalPageCount
            const nextStartLine = hasMoreBelow
              ? rangeEndPageInclusive + 1
              : null

            // When an explicit modality request was silently re-mapped to
            // text by the resolver, mark `effectiveModality` so callers /
            // log readers can observe the divergence between requested and
            // executed mode. Default (undefined) lands here too — but we
            // only emit the marker when there's an actual divergence.
            //
            // Two visible divergences trigger metadata:
            //   - 'image' on text-only model → text (caller asked for image
            //     but the model can't do vision). Carries a model-visible
            //     warning so the model knows its visual request was lost.
            //   - 'pdf' on non-PDF model → text (caller asked for native
            //     PDF, model doesn't support it). No warning text — the
            //     downgrade is the system's choice, not something the model
            //     should try to "correct" by asking again.
            const visionDowngraded =
              operation.modality === 'image' && !chatModelAcceptsImages
            const pdfDowngraded =
              operation.modality === 'pdf' && !chatModelAcceptsPdf

            results.push({
              path,
              ok: true,
              totalLines,
              returnedRange:
                operation.type === 'lines'
                  ? {
                      startLine: returnedStartLine,
                      endLine: returnedEndLine,
                    }
                  : undefined,
              hasMoreBelow,
              nextStartLine,
              content: outputContent,
              ...(visionDowngraded
                ? {
                    effectiveModality: 'text' as const,
                    warning: subpathWarning
                      ? `当前模型不支持图像输入，已自动降级为文本读取 ${subpathWarning}`
                      : '当前模型不支持图像输入，已自动降级为文本读取',
                  }
                : pdfDowngraded
                  ? {
                      effectiveModality: 'text' as const,
                      ...(subpathWarning ? { warning: subpathWarning } : {}),
                    }
                  : subpathWarning
                    ? { warning: subpathWarning }
                    : {}),
              ...wikilinkResultFields,
            })
            continue
          }

          const officeKind = getOfficeDocumentKindFromExtension(file.extension)
          if (officeKind) {
            if (file.stat.size > OFFICE_READ_MAX_BYTES) {
              results.push({
                path,
                ok: false,
                error: `Office document too large (${file.stat.size} bytes).`,
              })
              continue
            }

            try {
              const rawBuf = await app.vault.readBinary(file)
              const parsed = await parseOfficeDocument(rawBuf, officeKind)
              const content = parsed.markdown
              const lines = content.length === 0 ? [] : content.split('\n')
              const sliced = sliceLinesForFsReadOperation(lines, operation)

              results.push({
                path,
                ok: true,
                totalLines: sliced.totalLines,
                returnedRange:
                  operation.type === 'lines'
                    ? {
                        startLine: sliced.returnedStartLine,
                        endLine: sliced.returnedEndLine,
                      }
                    : undefined,
                hasMoreBelow: sliced.hasMoreBelow,
                nextStartLine: sliced.nextStartLine,
                content: sliced.outputContent,
                ...wikilinkResultFields,
                ...(subpathWarning ? { warning: subpathWarning } : {}),
              })
            } catch (error) {
              results.push({
                path,
                ok: false,
                error:
                  error instanceof Error
                    ? error.message
                    : typeof error === 'string'
                      ? error
                      : JSON.stringify(error),
              })
            }
            continue
          }

          if (file.stat.size > MAX_FILE_SIZE_BYTES) {
            results.push({
              path,
              ok: false,
              error: `File too large (${file.stat.size} bytes).`,
            })
            continue
          }

          // A subpath resolved from wikilink fallback only takes effect for
          // a `full` read — an explicit startLine/endLine/maxLines from the
          // caller always wins and the subpath is used only to locate the
          // file.
          const effectiveOperation: FsReadOperation =
            resolvedSubpath && operation.type === 'full'
              ? {
                  type: 'lines',
                  startLine: resolvedSubpath.startLine,
                  endLine: resolvedSubpath.endLine,
                  modality: operation.modality,
                  format: operation.format,
                }
              : operation

          const rawContent = await app.vault.read(file)
          const content = rawContent
          const lines = content.length === 0 ? [] : content.split('\n')
          const sliced = sliceLinesForFsReadOperation(lines, effectiveOperation)
          const outputContent = sliced.outputContent
          const rawSelected = sliced.rawSelected

          const wikilinks =
            file.extension === 'md' && rawSelected.length > 0
              ? collectWikilinkPaths(app, rawSelected, file.path)
              : []

          results.push({
            path,
            ok: true,
            totalLines: sliced.totalLines,
            returnedRange:
              effectiveOperation.type === 'lines'
                ? {
                    startLine: sliced.returnedStartLine,
                    endLine: sliced.returnedEndLine,
                  }
                : undefined,
            hasMoreBelow: sliced.hasMoreBelow,
            nextStartLine: sliced.nextStartLine,
            content: outputContent,
            ...(wikilinks.length > 0 ? { wikilinks } : {}),
            ...wikilinkResultFields,
            ...(subpathWarning ? { warning: subpathWarning } : {}),
          })

          // Extract images from markdown files using the outputContent
          // (which is the line-numbered text that was actually returned)
          if (
            chatModelAcceptsImages &&
            (settings?.chatOptions?.imageReadingEnabled ?? true) &&
            file.extension === 'md' &&
            outputContent.length > 0
          ) {
            const imageResult = await extractMarkdownImages(
              app,
              outputContent,
              file.path,
              {
                compression: {
                  enabled:
                    settings?.chatOptions?.imageCompressionEnabled ?? true,
                  quality: settings?.chatOptions?.imageCompressionQuality ?? 85,
                },
                cache: { enabled: true, settings },
                externalUrl: {
                  enabled:
                    settings?.chatOptions?.externalImageFetchEnabled ?? false,
                },
              },
            )
            if (imageResult.contentParts) {
              perFileAttachmentParts.push({
                path,
                parts: imageResult.contentParts,
              })
            }
          }
        }

        const textResult = formatJsonResult({
          toolCallId: toolCallId ?? null,
          // Echo the requested modality so the model can compare it against
          // each result's `effectiveModality` (only set when we forcibly
          // downgrade image→text because the model lacks vision capability).
          requestedOperation: {
            type: operation.type,
            modality: operation.modality,
          },
          results,
        })

        // contentParts only carries image payloads — the request builder
        // filters to image_url parts and ignores any text entries here, so we
        // skip building per-file text headers that would just be discarded.
        // The text JSON (above) is the source of truth for paths/ranges.
        const contentParts: ContentPart[] | undefined =
          perFileAttachmentParts.length > 0
            ? perFileAttachmentParts.flatMap((p) => p.parts)
            : undefined

        const firstReadableResult = results[0]?.ok ? results[0] : undefined
        const isPdf =
          typeof firstReadableResult?.path === 'string' &&
          firstReadableResult.path.toLowerCase().endsWith('.pdf')
        const fsReadOperation: ToolFsReadOperationSummary | undefined = (() => {
          if (!firstReadableResult) {
            return undefined
          }
          if (operation.type === 'full') {
            return {
              type: 'full',
              isPdf,
              ...(readSkillNames.length === paths.length
                ? { skillNames: readSkillNames }
                : {}),
            }
          }
          const returnedRange = firstReadableResult.returnedRange
          if (
            typeof returnedRange?.startLine !== 'number' ||
            typeof returnedRange.endLine !== 'number'
          ) {
            return undefined
          }
          return {
            type: 'lines',
            startLine: returnedRange.startLine,
            endLine: returnedRange.endLine,
            isPdf,
            ...(readSkillNames.length === paths.length
              ? { skillNames: readSkillNames }
              : {}),
          }
        })()

        return {
          status: ToolCallResponseStatus.Success,
          text: textResult,
          contentParts,
          metadata: fsReadOperation ? { fsReadOperation } : undefined,
        }
      }

      case 'fs_edit': {
        const path = validateVaultPath(getTextArg(args, 'path'))
        const plan = getFsEditPlan(args)

        const file = app.vault.getAbstractFileByPath(path)
        if (!file || !(file instanceof TFile)) {
          throw new Error(`File not found: ${path}`)
        }
        if (file.stat.size > MAX_EDIT_FILE_SIZE_BYTES) {
          throw new Error(`File too large (${file.stat.size} bytes).`)
        }

        const content = await app.vault.read(file)
        const materialized = materializeTextEditPlan({
          content,
          plan,
        })

        if (materialized.errors.length > 0) {
          const replaceFailure = materialized.failures?.find(
            (failure) =>
              failure.operation.type === 'replace' &&
              failure.kind === 'no_match',
          )
          if (replaceFailure && replaceFailure.operation.type === 'replace') {
            throw new Error(
              `${path}: ${buildReplaceMatchErrorHint({
                content,
                oldText: replaceFailure.operation.oldText,
              })}`,
            )
          }
          throw new Error(`${path}: ${materialized.errors[0]}`)
        }

        const nextContent = materialized.newContent

        if (nextContent.length > MAX_EDIT_FILE_SIZE_BYTES) {
          throw new Error(
            `Content too large (${nextContent.length} chars). Max allowed is ${MAX_EDIT_FILE_SIZE_BYTES}.`,
          )
        }

        let appliedContent = nextContent
        let reviewResultSummary: NonNullable<ApplyViewResult['review']> | null =
          null

        if (requireReview) {
          if (!openApplyReview) {
            throw new Error('Apply review is unavailable for fs_edit.')
          }

          const reviewResult = await waitForFsEditReview({
            openApplyReview,
            file,
            originalContent: content,
            newContent: nextContent,
            reviewEdits: materialized.reviewEdits,
            selectionRange: getFsEditSelectionRange(
              content,
              materialized.operationResults,
            ),
            signal,
          })

          if (reviewResult.status === ToolCallResponseStatus.Aborted) {
            return reviewResult
          }
          if (reviewResult.status === ToolCallResponseStatus.Rejected) {
            return {
              status: ToolCallResponseStatus.Rejected,
              reason: buildFsEditRejectedReason(),
            }
          }

          appliedContent = reviewResult.finalContent
          reviewResultSummary = reviewResult.review
        } else {
          await maybeWithInternalWrite(promptSourceWatcher, path, () =>
            app.vault.modify(file, nextContent),
          )
        }

        const appliedAt = Date.now()
        // MAX_FILE_SIZE_BYTES 作为"快照阈值"：当编辑前或编辑后的内容超过阈值时，
        // 跳过 undo/review 快照与 diff（避免把超大内容读进快照存储），与 fs_write
        // 覆盖超大文件时的行为对齐。必须同时看 before(content) 与 after(appliedContent)，
        // 因为小文件也可能被编辑后膨胀到阈值以上。
        const overSized =
          content.length > MAX_FILE_SIZE_BYTES ||
          appliedContent.length > MAX_FILE_SIZE_BYTES
        const metadata = overSized
          ? undefined
          : await buildFileChangeSummary({
              app,
              settings,
              path,
              beforeContent: content,
              afterContent: appliedContent,
              beforeExists: true,
              afterExists: true,
              conversationId,
              roundId,
              toolCallId,
              appliedAt,
            })

        const resultPayload = reviewResultSummary
          ? {
              tool: 'fs_edit',
              path,
              changed: content !== appliedContent,
              review: buildFsEditReviewPayload(reviewResultSummary),
              message:
                reviewResultSummary.rejectedChanges.length > 0
                  ? 'Explicit user decision: the listed change was rejected in the review UI. This is not an edit or matching failure. Do not retry it with another locator or tool this turn; acknowledge the decision and wait for the user.'
                  : 'Applied reviewed edit.',
            }
          : {
              tool: 'fs_edit',
              path,
              totalOperations: materialized.totalOperations,
              appliedCount: materialized.appliedCount,
              operationResults: materialized.operationResults.map((result) => ({
                type: result.operation.type,
                changed: result.changed,
                actualOccurrences: result.actualOccurrences,
                matchMode: result.matchMode,
              })),
              changed: content !== appliedContent,
              message: overSized
                ? 'Applied edit (content too large for undo snapshot).'
                : 'Applied edit.',
            }

        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult(resultPayload),
          metadata,
        }
      }

      case 'fs_write': {
        const path = normalizePath(getTextArg(args, 'path'))
        return maybeWithInternalWrite(promptSourceWatcher, path, () =>
          executeFsFileOps({
            app,
            settings,
            action: 'write',
            item: {
              path,
              content: getTextArg(args, 'content'),
            },
            signal,
            tool: 'fs_write',
            conversationId,
            roundId,
            toolCallId,
          }),
        )
      }

      case BASH_TOOL_NAME: {
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
              getRagEngine,
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
              text: formatJsonResult({
                tool: BASH_TOOL_NAME,
                exit_code: result.exitCode,
                stdout: truncateBashOutputForContext(
                  result.stdout,
                  VAULT_BASH_STDOUT_BUDGET,
                ),
                stderr: truncateBashOutputForContext(
                  result.stderr,
                  VAULT_BASH_STDERR_BUDGET,
                ),
              }),
            }
          } finally {
            signal?.removeEventListener('abort', onAbort)
            session.dispose()
          }
        } finally {
          lease.release()
        }
      }

      case 'web_search': {
        if (!settings) {
          throw new Error('Web search is unavailable: settings not loaded.')
        }
        const query = getTextArg(args, 'query').trim()
        if (!query) {
          throw new Error('query cannot be empty.')
        }
        const topic = getOptionalTextArg(args, 'topic')?.trim() || undefined
        const result = await runWebSearch({
          settings: settings.webSearch,
          query,
          topic,
          signal,
        })
        const itemsWithIndex = result.items.map((it, idx) => ({
          id: it.id,
          index: idx + 1,
          title: it.title,
          url: it.url,
          text: it.text,
        }))
        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult({
            tool: 'web_search',
            provider: result.providerName,
            answer: result.answer,
            items: itemsWithIndex,
          }),
        }
      }

      case 'web_scrape': {
        if (!settings) {
          throw new Error('Web scrape is unavailable: settings not loaded.')
        }
        const url = getTextArg(args, 'url').trim()
        if (!url) {
          throw new Error('url cannot be empty.')
        }
        const result = await runWebScrape({
          settings: settings.webSearch,
          url,
          signal,
        })
        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult({
            tool: 'web_scrape',
            provider: result.providerName,
            url: result.url,
            title: result.title,
            content: result.content,
          }),
        }
      }

      case JS_SANDBOX_TOOL_NAME: {
        const jsSandboxSettings = getJsSandboxSettings(settings)
        const proxyHandlers = buildJsSandboxProxyHandlers(
          app,
          jsSandboxSettings,
          getRagEngine,
          settings,
        )
        return callJsSandboxTool({
          app,
          args,
          signal,
          jsSandboxSettings,
          proxyHandlers,
        })
      }

      case 'memory_add': {
        if (args.items !== undefined) {
          const items = getRecordArrayArg(args, 'items')
          if (items.length === 0) {
            throw new Error('items cannot be empty.')
          }

          const results: Array<
            | {
                ok: true
                id: string
                scope: MemoryScope
                filePath: string
              }
            | {
                ok: false
                error: string
                scope: MemoryScope
              }
          > = []

          for (const item of items) {
            try {
              const result = await invokeMemoryTool(
                promptSourceWatcher,
                (hooks) =>
                  memoryAdd({
                    app,
                    settings,
                    content: item.content,
                    category: item.category,
                    scope: item.scope ?? args.scope,
                    assistantId: settings?.currentAssistantId,
                    ...hooks,
                  }),
              )
              results.push({
                ok: true,
                id: result.id,
                scope: result.scope,
                filePath: result.filePath,
              })
            } catch (error) {
              results.push({
                ok: false,
                error: asErrorMessage(error),
                scope:
                  typeof (item.scope ?? args.scope) === 'string' &&
                  String(item.scope ?? args.scope)
                    .trim()
                    .toLowerCase() === 'global'
                    ? 'global'
                    : 'assistant',
              })
            }
          }

          return {
            status: ToolCallResponseStatus.Success,
            text: formatJsonResult({
              tool: 'memory_add',
              mode: 'batch',
              results,
              okCount: results.filter((result) => result.ok).length,
              failCount: results.filter((result) => !result.ok).length,
            }),
          }
        }

        if (args.content === undefined) {
          throw new Error('content or items is required.')
        }

        const result = await invokeMemoryTool(promptSourceWatcher, (hooks) =>
          memoryAdd({
            app,
            settings,
            content: args.content,
            category: args.category,
            scope: args.scope,
            assistantId: settings?.currentAssistantId,
            ...hooks,
          }),
        )

        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult({
            tool: 'memory_add',
            id: result.id,
            scope: result.scope,
            filePath: result.filePath,
          }),
        }
      }

      case 'memory_update': {
        const result = await invokeMemoryTool(promptSourceWatcher, (hooks) =>
          memoryUpdate({
            app,
            settings,
            id: args.id,
            newContent: args.new_content,
            scope: args.scope,
            assistantId: settings?.currentAssistantId,
            ...hooks,
          }),
        )

        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult({
            tool: 'memory_update',
            id: result.id,
            scope: result.scope,
            filePath: result.filePath,
          }),
        }
      }

      case 'memory_delete': {
        if (args.ids !== undefined) {
          const ids = getStringArrayArg(args, 'ids')
          if (ids.length === 0) {
            throw new Error('ids cannot be empty.')
          }

          const results: Array<
            | {
                ok: true
                id: string
                scope: MemoryScope
                filePath: string
              }
            | {
                ok: false
                id: string
                error: string
                scope: MemoryScope
              }
          > = []

          for (const id of ids) {
            try {
              const result = await invokeMemoryTool(
                promptSourceWatcher,
                (hooks) =>
                  memoryDelete({
                    app,
                    settings,
                    id,
                    scope: args.scope,
                    assistantId: settings?.currentAssistantId,
                    ...hooks,
                  }),
              )
              results.push({
                ok: true,
                id: result.id,
                scope: result.scope,
                filePath: result.filePath,
              })
            } catch (error) {
              results.push({
                ok: false,
                id,
                error: asErrorMessage(error),
                scope:
                  typeof args.scope === 'string' &&
                  args.scope.trim().toLowerCase() === 'global'
                    ? 'global'
                    : 'assistant',
              })
            }
          }

          return {
            status: ToolCallResponseStatus.Success,
            text: formatJsonResult({
              tool: 'memory_delete',
              mode: 'batch',
              results,
              okCount: results.filter((result) => result.ok).length,
              failCount: results.filter((result) => !result.ok).length,
            }),
          }
        }

        if (args.id === undefined) {
          throw new Error('id or ids is required.')
        }

        const result = await invokeMemoryTool(promptSourceWatcher, (hooks) =>
          memoryDelete({
            app,
            settings,
            id: args.id,
            scope: args.scope,
            assistantId: settings?.currentAssistantId,
            ...hooks,
          }),
        )

        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult({
            tool: 'memory_delete',
            id: result.id,
            scope: result.scope,
            filePath: result.filePath,
          }),
        }
      }

      case 'delegate_subagent': {
        if (!subagentParentContext) {
          throw new Error(
            'delegate_subagent is only available during an active parent agent run.',
          )
        }
        if (!conversationId) {
          throw new Error('conversationId is required for delegate_subagent.')
        }

        const description = getTextArg(args, 'description').trim()
        const taskPrompt = getTextArg(args, 'prompt').trim()
        if (!settings) {
          throw new Error('settings are required for delegate_subagent.')
        }
        const requestedModelId =
          getOptionalTextArg(args, 'modelId')?.trim() ?? ''
        const subagentModelConfig = resolveSubagentModelConfig(settings)
        if (subagentModelConfig.allowedModelIds.length === 0) {
          throw new Error(
            'No registered chat models are configured for delegate_subagent.',
          )
        }
        if (
          requestedModelId &&
          !subagentModelConfig.allowedModelIds.includes(requestedModelId)
        ) {
          throw new Error(
            `Model "${requestedModelId}" is not allowed for delegate_subagent.`,
          )
        }
        const selectedModelId =
          requestedModelId || subagentModelConfig.preferredModelId
        if (!selectedModelId) {
          throw new Error(
            'No preferred chat model is configured for delegate_subagent.',
          )
        }
        const { getChatModelClient } = await import('../llm/manager')
        const selectedModelClient = getChatModelClient({
          settings,
          modelId: selectedModelId,
        })
        const selectedProvider = settings.providers.find(
          (provider) => provider.id === selectedModelClient.model.providerId,
        )

        let assistantMessageId = ''
        if (conversationMessages) {
          for (let i = conversationMessages.length - 1; i >= 0; i--) {
            const m = conversationMessages[i]
            if (m.role === 'assistant') {
              assistantMessageId = m.id
              break
            }
          }
        }

        const { runSubagent } = await import('../agent/subagent/runner')
        const accepted = await runSubagent({
          description,
          prompt: taskPrompt,
          conversationId,
          source: {
            type: 'llm_tool_call',
            toolCallId: toolCallId ?? '',
            assistantMessageId,
          },
          parent: subagentParentContext,
          childModel: {
            providerClient: selectedModelClient.providerClient,
            model: selectedModelClient.model,
            apiType: selectedProvider?.apiType ?? null,
          },
          signal,
        })

        return {
          status: ToolCallResponseStatus.Success,
          text: JSON.stringify(accepted),
        }
      }

      case TERMINAL_COMMAND_TOOL_NAME: {
        const { runBash } = await import('../agent/bash/index')

        let assistantMessageId = ''
        if (conversationMessages) {
          for (let i = conversationMessages.length - 1; i >= 0; i--) {
            const m = conversationMessages[i]
            if (m.role === 'assistant') {
              assistantMessageId = m.id
              break
            }
          }
        }

        let cwd = getOptionalTextArg(args, 'cwd')?.trim() ?? ''
        if (!cwd) {
          const adapter = app.vault.adapter
          if (adapter instanceof FileSystemAdapter) {
            cwd = adapter.getBasePath()
          }
        }

        const result = await runBash({
          command: getOptionalTextArg(args, 'command'),
          sessionId: getOptionalBoundedIntegerArg({
            args,
            key: 'session_id',
            min: 1,
            max: Number.MAX_SAFE_INTEGER,
          }),
          input: getOptionalTextArg(args, 'input'),
          background: getOptionalBooleanArg(args, 'background') ?? false,
          cwd: cwd || undefined,
          timeoutSeconds: getOptionalBoundedIntegerArg({
            args,
            key: 'timeout',
            min: 1,
            max: 600,
          }),
          tailLines: getOptionalBoundedIntegerArg({
            args,
            key: 'tail_lines',
            min: 1,
            max: 10_000,
          }),
          tailBytes: getOptionalBoundedIntegerArg({
            args,
            key: 'tail_bytes',
            min: 1,
            max: 1_048_576,
          }),
          kill: getOptionalBooleanArg(args, 'kill') ?? false,
          signal,
          conversationId,
          source:
            conversationId && toolCallId && assistantMessageId
              ? {
                  type: 'llm_tool_call',
                  toolCallId,
                  assistantMessageId,
                }
              : undefined,
        })

        const exitOk =
          result.exit_code === undefined ||
          result.exit_code === null ||
          result.exit_code === 0
        const text = JSON.stringify(
          {
            session_id: result.session_id,
            state: result.state,
            exit_code: result.exit_code,
            stdout: result.stdout,
            stderr: result.stderr,
          },
          null,
          2,
        )

        if (!exitOk) {
          return {
            status: ToolCallResponseStatus.Error,
            error: `Exit code ${result.exit_code}. Output:\n${text}`,
          }
        }

        return {
          status: ToolCallResponseStatus.Success,
          text,
          metadata: result.truncated
            ? { truncated: result.truncated }
            : undefined,
        }
      }

      case LOAD_TOOL_SCHEMAS_LOCAL_TOOL_NAME: {
        throw new Error(
          'load_tool_schemas is only available through the Agent runtime.',
        )
      }

      case 'todo_write': {
        return executeTodoWrite({ args })
      }

      default:
        throw new Error(`Unknown local file tool: ${toolName}`)
    }
  } catch (error) {
    return {
      status: ToolCallResponseStatus.Error,
      error: asErrorMessage(error),
    }
  }
}

function executeTodoWrite({
  args,
}: {
  args: Record<string, unknown>
}): LocalToolCallResult {
  const rawTodos = args.todos
  if (!Array.isArray(rawTodos)) {
    return {
      status: ToolCallResponseStatus.Error,
      error: 'todos must be an array.',
    }
  }

  const todos: TodoItem[] = []
  for (let i = 0; i < rawTodos.length; i++) {
    const item = rawTodos[i]
    if (typeof item !== 'object' || item === null) {
      return {
        status: ToolCallResponseStatus.Error,
        error: `todos[${i}] must be an object.`,
      }
    }
    const { content, status } = item as Record<string, unknown>
    if (typeof content !== 'string' || content.trim() === '') {
      return {
        status: ToolCallResponseStatus.Error,
        error: `todos[${i}].content must be a non-empty string.`,
      }
    }
    if (
      status !== 'pending' &&
      status !== 'in_progress' &&
      status !== 'completed'
    ) {
      return {
        status: ToolCallResponseStatus.Error,
        error: `todos[${i}].status must be "pending", "in_progress", or "completed".`,
      }
    }
    todos.push({ content, status })
  }

  const inProgressCount = todos.filter((t) => t.status === 'in_progress').length
  if (inProgressCount > 1) {
    return {
      status: ToolCallResponseStatus.Error,
      error: `At most one todo may be in_progress at a time, but ${inProgressCount} were provided.`,
    }
  }

  return {
    status: ToolCallResponseStatus.Success,
    text: 'Todos updated. Continue tracking your progress with the todo list.',
  }
}
