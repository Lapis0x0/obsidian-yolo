import type { ChatModelModality } from '../../types/chat-model.types'
import { McpTool } from '../../types/mcp.types'
import { recoverLikelyEscapedBackslashSequences } from '../edits/textEditEngine'
import {
  LOAD_TOOL_SCHEMAS_TOOL_NAME as LOAD_TOOL_SCHEMAS_LOCAL_TOOL_NAME,
  getLoadToolSchemasTool,
} from '../tools/internal/load_tool_schemas/definition'
import {
  type BuiltinToolName,
  assertNoDuplicates,
  getToolDefinition,
  listBuiltinTools,
} from '../tools/registry'
import type { ToolCatalogContext } from '../tools/types'
import { WEB_SCRAPE_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from '../web-search'

import { JS_SANDBOX_TOOL_NAME } from './jsSandboxTool'
import { LOCAL_FILE_TOOL_SERVER } from './localFileToolNames'
import { parseToolName } from './tool-name-utils'

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
// 'delete' | 'create_dir' | 'move' retired with fs_delete/fs_create_dir/fs_move
// (see the bash tool, which now covers path operations via vaultFileOps.ts).
type FsFileOpAction = 'write'

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
