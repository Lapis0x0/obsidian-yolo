import Ajv, {
  type Ajv as AjvInstance,
  type ValidateFunction as AjvValidateFunction,
} from 'ajv'
import { Platform } from 'obsidian'
import { v4 as uuidv4 } from 'uuid'

import {
  AssistantToolApprovalMode,
  AssistantToolPreference,
  AssistantToolServerPreference,
  AssistantWorkspaceScope,
} from '../../types/assistant.types'
import {
  ChatConversationCompactionLike,
  ChatMessage,
  ChatToolMessage,
} from '../../types/chat'
import { McpTool } from '../../types/mcp.types'
import type { LLMProviderApiType } from '../../types/provider.types'
import {
  ToolCallRequest,
  ToolCallResponse,
  ToolCallResponseStatus,
  createCompleteToolCallArguments,
  createPartialToolCallArguments,
  getToolCallArgumentsObject,
  getToolCallArgumentsText,
} from '../../types/tool-call.types'
import {
  parseAndRepairToolArguments,
  parseAndRepairToolArgumentsText,
} from '../../utils/chat/tool-argument-parser'
import { captureLLMDebugOperation } from '../llm/debugCapture'
import {
  ASK_USER_QUESTION_TOOL_NAME,
  BASH_TOOL_NAME,
  LOAD_TOOL_SCHEMAS_LOCAL_TOOL_NAME,
  TERMINAL_COMMAND_TOOL_NAME,
  getLocalFileToolServerName,
  isAskUserQuestionToolName,
  isLocalFsWriteToolName,
  validateAskUserQuestionArgs,
} from '../mcp/localFileTools'
import { McpManager } from '../mcp/mcpManager'
import { parseToolName } from '../mcp/tool-name-utils'
import { unwrapInvokeToolArguments } from '../tools/internal/invoke_tool/definition'
import {
  type NativePathBoundary,
  OUTSIDE_VAULT_ALLOWANCE_KEY,
  isInsideVault,
  resolveNativePathWithin,
} from '../tools/native/paths'
import {
  getCapabilityOverrideForTool,
  getToolDefinition,
} from '../tools/registry'
import type { ChatModeCapabilityOverrides } from '../tools/types'

import {
  DEFAULT_BLOCKED_PREFIXES,
  classifyBashCommandSafety,
  isBlockedByCommandPrefix,
} from './bash/command-classifier'
import type { SubagentParentContext } from './subagent/parent-context'
import { isSubagentBlockedToolName } from './subagent/tool-filter'
import {
  LOAD_TOOL_SCHEMAS_RESULT_TOOL,
  extractLoadedDeferredToolNames,
} from './tool-disclosure'
import {
  getAssistantToolApprovalMode,
  getAssistantToolDisclosureMode,
  isAssistantToolEnabled,
} from './tool-preferences'
import { isInvokeToolName, isLoadToolSchemasToolName } from './tool-selection'
import {
  buildAllowedSkillPathSet,
  describePathDenial,
  findPathOutsideScope,
} from './workspaceScope'

type McpToolCallParams = Parameters<McpManager['callTool']>[0]
type McpToolCallParamsWithDebug = McpToolCallParams & {
  debugTraceId?: string
}

const getTypeName = (value: unknown): string => {
  if (Array.isArray(value)) return 'array'
  return typeof value
}

const requireStringField = ({
  args,
  field,
  errors,
}: {
  args: Record<string, unknown>
  field: string
  errors: string[]
}): void => {
  if (typeof args[field] !== 'string') {
    errors.push(
      `${field} must be a string; received ${getTypeName(args[field])}.`,
    )
  }
}

const requireIntegerField = ({
  args,
  field,
  errors,
}: {
  args: Record<string, unknown>
  field: string
  errors: string[]
}): void => {
  if (typeof args[field] !== 'number' || !Number.isInteger(args[field])) {
    errors.push(
      `${field} must be an integer; received ${getTypeName(args[field])}.`,
    )
  }
}

const validateLocalWriteArgs = ({
  toolName,
  args,
}: {
  toolName: string
  args: Record<string, unknown>
}): string[] => {
  const errors: string[] = []

  switch (toolName) {
    case 'fs_write':
      requireStringField({ args, field: 'path', errors })
      requireStringField({ args, field: 'content', errors })
      break
    case 'fs_edit': {
      requireStringField({ args, field: 'path', errors })
      requireStringField({ args, field: 'newText', errors })
      const hasOldText = typeof args.oldText === 'string'
      const hasStartLine = args.startLine !== undefined
      const hasEndLine = args.endLine !== undefined
      if (hasOldText && (hasStartLine || hasEndLine)) {
        errors.push(
          'Use exactly one edit locator: oldText, or startLine with endLine; do not combine them.',
        )
      } else if (!hasOldText && !hasStartLine && !hasEndLine) {
        errors.push('Missing edit locator.')
      } else if (!hasOldText) {
        requireIntegerField({ args, field: 'startLine', errors })
        requireIntegerField({ args, field: 'endLine', errors })
      }
      break
    }
    case 'fs_delete':
    case 'fs_create_dir':
      requireStringField({ args, field: 'path', errors })
      break
    case 'fs_move':
      requireStringField({ args, field: 'oldPath', errors })
      requireStringField({ args, field: 'newPath', errors })
      break
  }

  return errors
}

const getRequiredLocalWriteArgumentNames = (toolName: string): string[] => {
  switch (toolName) {
    case 'fs_write':
      return ['path', 'content']
    case 'fs_edit':
      return ['path', 'newText']
    case 'fs_delete':
    case 'fs_create_dir':
      return ['path']
    case 'fs_move':
      return ['oldPath', 'newPath']
    default:
      return []
  }
}

const getToolCallDiagnostics = (request: ToolCallRequest) =>
  request.metadata?.argumentDiagnostics

const nonEmptyOrUndefined = <T extends object>(value: T): T | undefined =>
  Object.keys(value).length === 0 ? undefined : value

const getLocalWriteToolShortName = (toolCallName: string): string | null => {
  try {
    const parsed = parseToolName(toolCallName)
    if (parsed.serverName !== getLocalFileToolServerName()) return null
    return isLocalFsWriteToolName(parsed.toolName) ? parsed.toolName : null
  } catch {
    return null
  }
}

const hasUnsafeStringCompletionRepair = (repairActions: string[]): boolean => {
  return repairActions.includes('closed unterminated string')
}

const formatToolArgumentDiagnostics = ({
  request,
  title,
  parseError,
  providedParameterNames,
  requiredParameterNames,
  validationErrors,
  repairActions,
}: {
  request: ToolCallRequest
  title: string
  parseError?: string
  providedParameterNames?: string[]
  requiredParameterNames?: string[]
  validationErrors?: string[]
  repairActions?: string[]
}): string => {
  const diagnostics = getToolCallDiagnostics(request)
  const rawArguments = getToolCallArgumentsText(request.arguments) ?? ''
  const rawArgsLength = diagnostics?.rawArgsLength ?? rawArguments.length
  const rawArgsHead =
    (diagnostics?.rawArgsHead ?? rawArguments.slice(0, 240)) || '<empty>'
  const providedNames =
    providedParameterNames && providedParameterNames.length > 0
      ? providedParameterNames
      : getToolCallArgumentsObject(request.arguments)
        ? Object.keys(
            getToolCallArgumentsObject(request.arguments) ?? {},
          ).sort()
        : []
  const requiredNames = requiredParameterNames ?? []
  const isFsEdit = getLocalWriteToolShortName(request.name) === 'fs_edit'
  const repairSummary = repairActions?.length
    ? repairActions.join('; ')
    : diagnostics?.repairActions?.length
      ? diagnostics.repairActions.join('; ')
      : diagnostics?.repairApplied
        ? 'repair applied'
        : 'none'

  return [
    `${title}: "${request.name}" arguments are not executable.`,
    ...(parseError ? [`Parse error: ${parseError}`] : []),
    ...(validationErrors?.length
      ? ['Validation errors:', ...validationErrors.map((error) => `- ${error}`)]
      : []),
    `Provided parameter names: ${providedNames.length > 0 ? providedNames.join(', ') : '<none>'}.`,
    `${isFsEdit ? 'Always required parameter names' : 'Required parameter names'}: ${requiredNames.length > 0 ? requiredNames.join(', ') : '<unknown>'}.`,
    ...(isFsEdit
      ? [
          'Edit locator requirement: provide exactly one of oldText, or startLine together with endLine.',
        ]
      : []),
    `Raw args length: ${rawArgsLength}.`,
    `Raw args head: ${rawArgsHead}`,
    `finishReason: ${diagnostics?.finishReason ?? '<unknown>'}.`,
    `streamState: ${diagnostics?.streamState ?? '<unknown>'}; parseState: ${diagnostics?.parseState ?? '<unknown>'}; sealReason: ${diagnostics?.sealReason ?? '<unknown>'}.`,
    `repair: ${repairSummary}.`,
    'Retry by calling the tool again with a smaller, complete JSON object. Do not include huge file contents in one tool call when a narrower edit is possible.',
  ].join('\n')
}

export class AgentToolGateway {
  private readonly toolsEnabled: boolean
  private readonly allowedToolNames?: Set<string>
  private readonly toolPreferences?: Record<string, AssistantToolPreference>
  /**
   * Per-capability enabled/approval state for built-in tools (D9,
   * docs/plans/2026-08-15-tool-registry/phase2-migration.md D9). Sibling to
   * `toolPreferences`, which since that migration only carries remote MCP
   * tool state — every call below that resolves a *built-in* tool's approval
   * mode or enablement must pass both.
   */
  private readonly builtinCapabilityPreferences?: Record<
    string,
    AssistantToolPreference
  >
  private readonly toolServerPreferences?: Record<
    string,
    AssistantToolServerPreference
  >
  private readonly workspaceScope?: AssistantWorkspaceScope
  private readonly allowedSkillPaths?: readonly string[]
  private readonly apiType?: LLMProviderApiType | null
  private readonly subagentParentContext?: SubagentParentContext
  private readonly isSubagentChildRun: boolean
  private readonly toolApprovalConversationId?: string
  private readonly blockedCommandPrefixes: readonly string[] | null
  private readonly bypassToolApproval: boolean
  private readonly bashReadOnly: boolean
  private readonly moduleToolApprovalPolicies?: ReadonlyMap<string, boolean>
  /**
   * The running chat mode's own capability grant — see
   * `ChatModeCapabilityOverride`. Produced by `resolveChatModeRuntime` and
   * threaded down to `McpManager` as well, because a capability the mode
   * forces on has to be both offered to the model and executable.
   */
  private readonly capabilityOverrides?: ChatModeCapabilityOverrides
  /**
   * Where the vault is and what `~` means, for the outside-the-vault
   * approval (master.md §4 Q7/Q10). Present only for a mode that enforces
   * that boundary (Max); absent everywhere else, which is what keeps Agent's
   * long-standing terminal behavior unchanged.
   */
  private readonly vaultPathBoundary?: NativePathBoundary
  private readonly ajv: AjvInstance
  private readonly schemaValidatorCache = new Map<
    string,
    AjvValidateFunction | null
  >()

  constructor(
    private readonly mcpManager: McpManager,
    options?: {
      toolsEnabled?: boolean
      allowedToolNames?: string[]
      toolPreferences?: Record<string, AssistantToolPreference>
      builtinCapabilityPreferences?: Record<string, AssistantToolPreference>
      toolServerPreferences?: Record<string, AssistantToolServerPreference>
      workspaceScope?: AssistantWorkspaceScope
      allowedSkillPaths?: string[]
      apiType?: LLMProviderApiType | null
      subagentParentContext?: SubagentParentContext
      isSubagentChildRun?: boolean
      toolApprovalConversationId?: string
      blockedCommandPrefixes?: string[]
      bypassToolApproval?: boolean
      bashReadOnly?: boolean
      moduleToolApprovalPolicies?: ReadonlyMap<string, boolean>
      capabilityOverrides?: ChatModeCapabilityOverrides
      vaultPathBoundary?: NativePathBoundary
    },
  ) {
    this.toolsEnabled = options?.toolsEnabled ?? true
    // Post-D9, `allowedToolNames` is always already a fully-expanded list of
    // real tool FQNs (see `tool-selection.ts`'s `selectAllowedTools` for the
    // same reasoning) — no virtual group name expansion needed here.
    this.allowedToolNames = options?.allowedToolNames
      ? new Set(options.allowedToolNames)
      : undefined
    this.toolPreferences = options?.toolPreferences
    this.builtinCapabilityPreferences = options?.builtinCapabilityPreferences
    this.toolServerPreferences = options?.toolServerPreferences
    this.workspaceScope = options?.workspaceScope
    this.allowedSkillPaths = options?.allowedSkillPaths
    this.apiType = options?.apiType
    this.subagentParentContext = options?.subagentParentContext
    this.isSubagentChildRun = options?.isSubagentChildRun ?? false
    this.toolApprovalConversationId = options?.toolApprovalConversationId
    this.blockedCommandPrefixes = options?.blockedCommandPrefixes ?? null
    this.bypassToolApproval = options?.bypassToolApproval ?? false
    this.bashReadOnly = options?.bashReadOnly ?? false
    this.moduleToolApprovalPolicies = options?.moduleToolApprovalPolicies
    this.capabilityOverrides = options?.capabilityOverrides
    this.vaultPathBoundary = options?.vaultPathBoundary
    // `strict: false` keeps ajv tolerant of MCP tool schemas that include
    // vendor-specific keywords or non-canonical types. `allErrors` lists every
    // violation in the error message so the model has enough signal to retry;
    // `useDefaults: false` keeps validation side-effect free so we never
    // rewrite the model's arguments behind its back.
    this.ajv = new Ajv({ allErrors: true, useDefaults: false })
  }

  private async isOnDemandToolName(toolName: string): Promise<boolean> {
    if (isLoadToolSchemasToolName(toolName)) {
      return false
    }
    try {
      const { serverName } = parseToolName(toolName)
      if (serverName === getLocalFileToolServerName()) {
        return false
      }
    } catch {
      return false
    }
    return (
      getAssistantToolDisclosureMode(
        {
          toolPreferences: this.toolPreferences,
          toolServerPreferences: this.toolServerPreferences,
          enabledToolNames: this.allowedToolNames
            ? [...this.allowedToolNames]
            : undefined,
        },
        toolName,
      ) === 'on_demand'
    )
  }

  private async getRealToolSchema(toolName: string): Promise<McpTool | null> {
    // We don't have model-specific modality context here; built-in tool
    // modality narrowing only affects display strings, not argument schemas,
    // so omitting it is safe for harness validation.
    const tools = await this.mcpManager.listAvailableTools({
      includeBuiltinTools: true,
      capabilityOverrides: this.capabilityOverrides,
    })
    return tools.find((tool) => tool.name === toolName) ?? null
  }

  private getOrCompileValidator(
    toolName: string,
    schema: unknown,
  ): AjvValidateFunction | null {
    const cacheKey = toolName
    if (this.schemaValidatorCache.has(cacheKey)) {
      return this.schemaValidatorCache.get(cacheKey) ?? null
    }
    let validator: AjvValidateFunction | null = null
    try {
      validator = this.ajv.compile(schema as object)
    } catch (error) {
      console.warn(
        '[YOLO] failed to compile JSON Schema for on-demand tool; skipping ajv validation',
        toolName,
        error,
      )
      validator = null
    }
    this.schemaValidatorCache.set(cacheKey, validator)
    return validator
  }

  /**
   * Harness gate that runs before tool dispatch, for tools that were never
   * registered in the request's `tools` field. The provider validated nothing
   * about them, so both invariants are ours to enforce:
   *
   *   1. The tool's real schema must have been disclosed via
   *      `load_tool_schemas` earlier in this conversation. Otherwise the model
   *      is guessing at the argument shape, and the error points it back at
   *      the loader so it can self-correct next turn.
   *   2. The arguments must validate against that real schema (ajv).
   *
   * The `invoke_tool` envelope is already gone by this point — it is opened in
   * `createToolMessage`, so `request` here names the real tool.
   */
  private async validateAndNormalizeRequest({
    request,
    loadedToolNames,
  }: {
    request: ToolCallRequest
    loadedToolNames: ReadonlySet<string>
  }): Promise<
    | { ok: true; request: ToolCallRequest }
    | { ok: false; response: ToolCallResponse }
  > {
    if (!(await this.isOnDemandToolName(request.name))) {
      return { ok: true, request }
    }

    if (!loadedToolNames.has(request.name)) {
      return {
        ok: false,
        response: {
          status: ToolCallResponseStatus.Error,
          error:
            `Tool "${request.name}" has not had its schema loaded in this conversation yet. ` +
            `Call yolo_local__load_tool_schemas with {"tools":["${request.name}"]} first; ` +
            `the next assistant turn can then invoke it.`,
        },
      }
    }

    const normalizedArgs = getToolCallArgumentsObject(request.arguments) ?? {}
    const realTool = await this.getRealToolSchema(request.name)
    if (!realTool) {
      return {
        ok: false,
        response: {
          status: ToolCallResponseStatus.Error,
          error: `Tool "${request.name}" is not available in this workspace.`,
        },
      }
    }
    const validator = this.getOrCompileValidator(request.name, {
      ...realTool.inputSchema,
      properties: realTool.inputSchema.properties ?? {},
    })
    if (validator && !validator(normalizedArgs)) {
      const errorDetail = this.ajv.errorsText(validator.errors, {
        separator: '; ',
      })
      return {
        ok: false,
        response: {
          status: ToolCallResponseStatus.Error,
          error:
            `Arguments for "${request.name}" failed schema validation: ${errorDetail}. ` +
            `Re-check the schema returned by yolo_local__load_tool_schemas and retry.`,
        },
      }
    }

    return { ok: true, request }
  }

  private findRequestPathOutsideScope(request: ToolCallRequest): string | null {
    if (!this.workspaceScope?.enabled) return null
    try {
      const parsed = parseToolName(request.name)
      if (parsed.serverName !== getLocalFileToolServerName()) return null
      const args = getToolCallArgumentsObject(request.arguments)
      return findPathOutsideScope(parsed.toolName, args, this.workspaceScope, {
        exemptPaths: this.allowedSkillPaths
          ? buildAllowedSkillPathSet(this.allowedSkillPaths)
          : undefined,
      })
    } catch {
      return null
    }
  }

  private prepareFinalToolCallRequest(
    request: ToolCallRequest,
  ):
    | { ok: true; request: ToolCallRequest }
    | { ok: false; request: ToolCallRequest; response: ToolCallResponse } {
    if (!request.arguments || request.arguments.kind === 'complete') {
      return { ok: true, request }
    }

    const parsed = parseAndRepairToolArguments(request.arguments)
    const localWriteToolName = getLocalWriteToolShortName(request.name)
    if (!parsed.ok) {
      return {
        ok: false,
        request,
        response: {
          status: ToolCallResponseStatus.Error,
          error: formatToolArgumentDiagnostics({
            request,
            title: 'Tool argument parsing failed',
            parseError: parsed.error,
            providedParameterNames: parsed.providedParameterNames,
            requiredParameterNames: localWriteToolName
              ? getRequiredLocalWriteArgumentNames(localWriteToolName)
              : undefined,
            repairActions: parsed.repairActions,
          }),
        },
      }
    }

    if (
      localWriteToolName &&
      parsed.repairApplied &&
      hasUnsafeStringCompletionRepair(parsed.repairActions)
    ) {
      return {
        ok: false,
        request,
        response: {
          status: ToolCallResponseStatus.Error,
          error: formatToolArgumentDiagnostics({
            request,
            title: 'Tool argument parsing failed',
            parseError:
              'Repair would close an unterminated string in a local write tool. This likely means file content was truncated, so the tool was not executed.',
            providedParameterNames: Object.keys(parsed.value).sort(),
            requiredParameterNames:
              getRequiredLocalWriteArgumentNames(localWriteToolName),
            repairActions: parsed.repairActions,
          }),
        },
      }
    }

    return {
      ok: true,
      request: {
        ...request,
        arguments: parsed.arguments,
        metadata: {
          ...request.metadata,
          argumentDiagnostics: {
            ...request.metadata?.argumentDiagnostics,
            parseState: parsed.repairApplied ? 'repaired' : 'valid',
            rawArgsLength:
              request.metadata?.argumentDiagnostics?.rawArgsLength ??
              getToolCallArgumentsText(request.arguments)?.length ??
              0,
            rawArgsHead:
              request.metadata?.argumentDiagnostics?.rawArgsHead ??
              getToolCallArgumentsText(request.arguments)?.slice(0, 240) ??
              '',
            repairApplied: parsed.repairApplied,
            repairActions: parsed.repairActions,
          },
        },
      },
    }
  }

  private getLocalWriteArgumentError(request: ToolCallRequest): string | null {
    const localWriteToolName = getLocalWriteToolShortName(request.name)
    if (!localWriteToolName) return null
    const toolName = localWriteToolName

    if (!request.arguments) {
      return formatToolArgumentDiagnostics({
        request: {
          ...request,
          arguments: createPartialToolCallArguments(''),
        },
        title: 'Tool argument parsing failed',
        parseError: 'Missing arguments. Expected a JSON object.',
        requiredParameterNames: getRequiredLocalWriteArgumentNames(toolName),
      })
    }

    if (request.arguments.kind === 'partial') {
      const parsed = parseAndRepairToolArgumentsText(request.arguments.rawText)
      return formatToolArgumentDiagnostics({
        request,
        title: 'Tool argument parsing failed',
        parseError: parsed.ok
          ? 'Arguments were still marked partial after parsing.'
          : parsed.error,
        providedParameterNames: parsed.ok
          ? Object.keys(parsed.value).sort()
          : parsed.providedParameterNames,
        requiredParameterNames: getRequiredLocalWriteArgumentNames(toolName),
        repairActions: parsed.repairActions,
      })
    }

    const validationErrors = validateLocalWriteArgs({
      toolName,
      args: request.arguments.value,
    })
    if (validationErrors.length === 0) {
      return null
    }

    return formatToolArgumentDiagnostics({
      request,
      title: 'Tool argument validation failed',
      providedParameterNames: Object.keys(request.arguments.value).sort(),
      requiredParameterNames: getRequiredLocalWriteArgumentNames(toolName),
      validationErrors,
    })
  }

  /**
   * Everything about the *running mode* that a tool call has to keep after
   * the run that created it is fixed here, at creation time, and read back
   * off `ToolCallRequest.metadata` afterwards — by the gateway's own initial
   * state, by the two execution paths that bypass the gateway
   * (`AgentService.approveToolCall` and the UI's recovery path), and by the
   * approval card. Nothing downstream re-derives it from a live registry or
   * a live mode, so reloading, upgrading or switching modes never changes the
   * outcome of a call that already exists.
   *
   * Three independent facts, each written only when it applies:
   *   - `approvalPolicy` / `executionConstraints`: module chat modes only
   *     (`moduleToolApprovalPolicies` is set by
   *     `resolveModuleChatModeRuntime` and nothing else). `approvalPolicy` is
   *     written only for tools the mode itself declared — host tools granted
   *     through the mode's capability tier keep normal approval resolution;
   *     `bashReadOnly` is written for every bash-identity call in such a run.
   *   - `allowAlwaysAllow`: the mode's override of the owning capability's
   *     `approval.allowAlwaysAllow` declaration (master.md §4 Q8 — Max opens
   *     "always allow" on the terminal).
   *   - `outsideVaultPath`: the resolved absolute path this call reaches
   *     outside the vault (master.md §4 Q7/Q10).
   */
  private attachChatModeSnapshot(request: ToolCallRequest): ToolCallRequest {
    const requiresApproval = this.moduleToolApprovalPolicies?.get(request.name)
    const approvalPolicy: 'auto' | 'always-require-user' | undefined =
      requiresApproval === undefined
        ? undefined
        : requiresApproval
          ? 'always-require-user'
          : 'auto'
    // Both facts the two gateway-bypassing execution paths cannot re-derive:
    // the module mode's bash tier, and whether the running mode granted this
    // call's capability past the user's global switch.
    const executionConstraints = nonEmptyOrUndefined({
      ...(this.moduleToolApprovalPolicies && this.isBashToolCall(request.name)
        ? { bashReadOnly: this.bashReadOnly }
        : {}),
      ...(this.resolveCapabilityOverride(request.name)?.forceEnabled
        ? { capabilityForceEnabled: true }
        : {}),
    })
    const allowAlwaysAllow = this.resolveCapabilityOverride(
      request.name,
    )?.allowAlwaysAllow
    const outsideVaultPath = this.findPathOutsideVault(request) ?? undefined
    if (
      approvalPolicy === undefined &&
      executionConstraints === undefined &&
      allowAlwaysAllow === undefined &&
      outsideVaultPath === undefined
    ) {
      return request
    }
    return {
      ...request,
      metadata: {
        ...request.metadata,
        ...(approvalPolicy !== undefined ? { approvalPolicy } : {}),
        ...(executionConstraints !== undefined ? { executionConstraints } : {}),
        ...(allowAlwaysAllow !== undefined ? { allowAlwaysAllow } : {}),
        ...(outsideVaultPath !== undefined ? { outsideVaultPath } : {}),
      },
    }
  }

  /** The running mode's override for the capability owning this tool, if any. */
  private resolveCapabilityOverride(toolName: string) {
    if (!this.capabilityOverrides) return undefined
    try {
      const parsed = parseToolName(toolName)
      if (parsed.serverName !== getLocalFileToolServerName()) return undefined
      return getCapabilityOverrideForTool(
        this.capabilityOverrides,
        parsed.toolName,
      )
    } catch {
      return undefined
    }
  }

  /**
   * The absolute path this call reaches when it lands outside the vault, or
   * null. Reads which argument carries a real filesystem path off the tool's
   * own `filesystemPathArg` declaration, and resolves it with exactly the
   * function the tool will use, against exactly the boundary the tool will
   * use — the check and the write must not be able to disagree.
   *
   * Null when the mode enforces no boundary (`vaultPathBoundary` absent),
   * when the tool declares no filesystem path, when the argument is missing,
   * and when the path cannot be resolved at all: an unresolvable path throws
   * identically inside the tool, so there is nothing here to approve.
   */
  private findPathOutsideVault(request: ToolCallRequest): string | null {
    const boundary = this.vaultPathBoundary
    if (!boundary) return null
    try {
      const parsed = parseToolName(request.name)
      if (parsed.serverName !== getLocalFileToolServerName()) return null
      const argKey = getToolDefinition(parsed.toolName)?.filesystemPathArg
      if (!argKey) return null
      const raw = getToolCallArgumentsObject(request.arguments)?.[argKey]
      if (typeof raw !== 'string' || raw.trim() === '') return null
      const resolved = resolveNativePathWithin(boundary, raw)
      return isInsideVault(resolved, boundary.vaultBasePath) ? null : resolved
    } catch {
      return null
    }
  }

  createToolMessage({
    toolCallRequests,
    conversationId,
    branchId,
    sourceUserMessageId,
    branchModelId,
    branchLabel,
  }: {
    toolCallRequests: ToolCallRequest[]
    conversationId: string
    branchId?: string
    sourceUserMessageId?: string
    branchModelId?: string
    branchLabel?: string
  }): ChatToolMessage {
    // The `invoke_tool` envelope is opened here, before anything that keys off
    // the tool's identity: the availability gate, workspace scope, blocked
    // terminal prefixes, the approval tier, the module approval snapshot, and
    // the chat renderers all see the real tool by construction.
    //
    // The order within this pipeline is load-bearing. Argument parsing has to
    // come first, because the wrapped name and arguments live inside the
    // parsed payload. `attachChatModeSnapshot` has to come *last*,
    // because it looks a tool up by name to find its declared approval
    // policy — run against the envelope it would silently miss a module tool's
    // `always-require-user` and let the user grant a blanket allow.
    const preparedRequests = toolCallRequests.map((request) => {
      const unwrapped = this.unwrapInvokeToolRequest(
        this.prepareFinalToolCallRequest(request),
      )
      return unwrapped.ok
        ? {
            ok: true as const,
            request: this.attachChatModeSnapshot(unwrapped.request),
          }
        : unwrapped
    })
    const normalizedToolCallRequests = preparedRequests.map(
      (prepared) => prepared.request,
    )
    // ask_user_question is exclusive within a single LLM turn. Detect this
    // up-front so we can force all sibling outcomes accordingly before falling
    // back to the per-tool routing for non-ask cases.
    const askIndices: number[] = []
    normalizedToolCallRequests.forEach((request, index) => {
      if (isAskUserQuestionToolName(request.name)) {
        askIndices.push(index)
      }
    })
    const hasAsk = askIndices.length > 0
    const firstAskIndex = hasAsk ? askIndices[0] : -1

    return {
      role: 'tool',
      id: uuidv4(),
      metadata: {
        branchConversationId: conversationId,
        branchId,
        sourceUserMessageId,
        branchModelId,
        branchLabel,
      },
      toolCalls: preparedRequests.map((prepared, index) => {
        const request = prepared.request
        return {
          request,
          response:
            prepared.ok === false
              ? prepared.response
              : this.resolveInitialResponse({
                  request,
                  conversationId,
                  isAskRequest:
                    hasAsk && index === firstAskIndex
                      ? 'primary-ask'
                      : hasAsk && askIndices.includes(index)
                        ? 'duplicate-ask'
                        : hasAsk
                          ? 'ask-sibling'
                          : 'normal',
                }),
        }
      }),
    }
  }

  private unwrapInvokeToolRequest(
    prepared:
      | { ok: true; request: ToolCallRequest }
      | { ok: false; request: ToolCallRequest; response: ToolCallResponse },
  ):
    | { ok: true; request: ToolCallRequest }
    | { ok: false; request: ToolCallRequest; response: ToolCallResponse } {
    if (!prepared.ok || !isInvokeToolName(prepared.request.name)) {
      return prepared
    }

    const args = getToolCallArgumentsObject(prepared.request.arguments) ?? {}
    const unwrapped = unwrapInvokeToolArguments({
      args,
      apiType: this.apiType,
      knownToolNames: this.allowedToolNames ? [...this.allowedToolNames] : null,
    })
    if (!unwrapped.ok) {
      return {
        ok: false,
        request: prepared.request,
        response: {
          status: ToolCallResponseStatus.Error,
          error: unwrapped.error,
        },
      }
    }

    return {
      ok: true,
      request: {
        ...prepared.request,
        name: unwrapped.toolName,
        arguments: createCompleteToolCallArguments({ value: unwrapped.args }),
      },
    }
  }

  private resolveInitialResponse({
    request,
    conversationId,
    isAskRequest,
  }: {
    request: ToolCallRequest
    conversationId: string
    isAskRequest: 'primary-ask' | 'duplicate-ask' | 'ask-sibling' | 'normal'
  }): ToolCallResponse {
    if (isAskRequest === 'duplicate-ask') {
      return {
        status: ToolCallResponseStatus.Error,
        error: `Only one ${ASK_USER_QUESTION_TOOL_NAME} call is allowed per turn.`,
      }
    }
    if (isAskRequest === 'ask-sibling') {
      return {
        status: ToolCallResponseStatus.Error,
        error: `This tool call cannot run alongside ${ASK_USER_QUESTION_TOOL_NAME} in the same turn.`,
      }
    }

    if (!this.isToolAllowed(request.name)) {
      return {
        status: ToolCallResponseStatus.Rejected,
        reason: `Tool "${request.name}" is not available in this workspace.`,
      }
    }

    const pathOutsideScope = this.findRequestPathOutsideScope(request)
    if (pathOutsideScope !== null) {
      return {
        status: ToolCallResponseStatus.Rejected,
        reason: `${describePathDenial('out-of-scope', pathOutsideScope)} Do not attempt to bypass this restriction. If the task requires this path, tell the user that it is outside the configured workspace scope.`,
      }
    }

    const localWriteArgumentError = this.getLocalWriteArgumentError(request)
    if (localWriteArgumentError) {
      return {
        status: ToolCallResponseStatus.Error,
        error: localWriteArgumentError,
      }
    }

    if (
      this.isBlockedTerminalCommand(
        getToolCallArgumentsObject(request.arguments),
        request.name,
      )
    ) {
      return {
        status: ToolCallResponseStatus.Error,
        error:
          'Terminal command rejected because it matches a blocked command prefix.',
      }
    }

    // Reaching outside the vault is its own permission, asked once and then
    // held for the whole conversation (master.md §4 Q7). It sits after the
    // unconditional blocked-prefix rejection above and before every approval
    // tier below, because it is a question about *where* the call lands, not
    // about how much the user trusts the tool: `full_access` on native_files
    // must not silently authorize a write to somewhere else on the machine.
    // Full trust (YOLO) skips it, exactly as it skips every other approval —
    // the blocked-prefix hard stop above is the only thing it never skips.
    const outsideVaultPath = request.metadata?.outsideVaultPath
    if (
      outsideVaultPath !== undefined &&
      !this.bypassToolApproval &&
      !this.mcpManager.isExecutionAllowanceGranted(
        OUTSIDE_VAULT_ALLOWANCE_KEY,
        this.toolApprovalConversationId ?? conversationId,
      )
    ) {
      return { status: ToolCallResponseStatus.PendingApproval }
    }

    if (isAskRequest === 'primary-ask') {
      const validation = validateAskUserQuestionArgs(
        getToolCallArgumentsObject(request.arguments) ?? {},
      )
      if (!validation.ok) {
        return {
          status: ToolCallResponseStatus.Error,
          error: `ask_user_question schema validation failed: ${validation.error}`,
        }
      }
      return { status: ToolCallResponseStatus.AwaitingUserInput }
    }

    // Module chat mode tools carry a persisted approval policy fixed at
    // creation time (see `attachChatModeSnapshot`). It fully replaces
    // the normal approval resolution below — in particular it is NOT
    // affected by `bypassToolApproval` (YOLO) or the mcpManager "always
    // allow this conversation" list, which only `shouldAutoExecuteTool`
    // consults. This is what makes `requiresApproval: true` an unconditional
    // per-call confirmation gate.
    const approvalPolicy = request.metadata?.approvalPolicy
    if (approvalPolicy !== undefined) {
      return approvalPolicy === 'auto'
        ? { status: ToolCallResponseStatus.Running }
        : { status: ToolCallResponseStatus.PendingApproval }
    }

    if (this.shouldAutoExecuteTool({ request, conversationId })) {
      return { status: ToolCallResponseStatus.Running }
    }

    return this.shouldUseFsEditReview(request.name)
      ? { status: ToolCallResponseStatus.Running }
      : { status: ToolCallResponseStatus.PendingApproval }
  }

  async executeAutoToolCalls({
    toolMessage,
    conversationId,
    conversationMessages,
    conversationCompaction,
    signal,
    chatModelId,
    debugTraceId,
  }: {
    toolMessage: ChatToolMessage
    conversationId: string
    conversationMessages?: ChatMessage[]
    conversationCompaction?: ChatConversationCompactionLike | null
    signal?: AbortSignal
    chatModelId?: string
    debugTraceId?: string
  }): Promise<ChatToolMessage> {
    const nextToolCalls = [...toolMessage.toolCalls]
    // Harness pre-pass. A deferred tool is invoked through `invoke_tool`, whose
    // `arguments` is an open object — the provider validates nothing — so this
    // is the only place its real schema is enforced, along with "the model
    // loaded that schema first". Failures convert the call's status to Error
    // with guidance pointing back to `load_tool_schemas`.
    //
    // `PendingApproval` is checked here too, not only `Running`: approval
    // dispatches straight to `mcpManager.callTool`, so a call validated only
    // on the auto path would reach the tool unchecked the moment it needs a
    // confirmation — and the user would be asked to approve arguments we
    // already know are malformed.
    const loadedToolNames = extractLoadedDeferredToolNames({
      messages: conversationMessages ?? [],
      compaction: conversationCompaction ?? null,
    })
    for (let i = 0; i < nextToolCalls.length; i += 1) {
      const entry = nextToolCalls[i]
      if (
        entry.response.status !== ToolCallResponseStatus.Running &&
        entry.response.status !== ToolCallResponseStatus.PendingApproval
      ) {
        continue
      }
      if (
        this.isBlockedTerminalCommand(
          getToolCallArgumentsObject(entry.request.arguments),
          entry.request.name,
        )
      ) {
        nextToolCalls[i] = {
          ...entry,
          response: {
            status: ToolCallResponseStatus.Error,
            error:
              'Terminal command rejected because it matches a blocked command prefix.',
          },
        }
        continue
      }
      const result = await this.validateAndNormalizeRequest({
        request: entry.request,
        loadedToolNames,
      })
      if (!result.ok) {
        nextToolCalls[i] = {
          ...entry,
          response: result.response,
        }
        continue
      }
      if (result.request !== entry.request) {
        nextToolCalls[i] = {
          ...entry,
          request: result.request,
        }
      }
    }
    // `AwaitingUserInput` is intentionally excluded here: it is a paused state
    // (only used by `ask_user_question`) and must not be auto-executed. The
    // gateway resumes it via `AgentService.answerUserQuestion` instead.
    const runnableEntries = nextToolCalls
      .map((toolCall, index) => ({ index, toolCall }))
      .filter(
        ({ toolCall }) =>
          toolCall.response.status === ToolCallResponseStatus.Running,
      )

    // Group sibling fs_edit calls targeting the same file so their operations
    // can be applied atomically against a single snapshot (one unified review,
    // one write). This prevents the "approve one, others fail" class of bugs
    // where later edits were computed against stale line numbers / text that
    // an earlier sibling has since modified.
    type RunnableEntry = (typeof runnableEntries)[number]
    const fsEditGroups = new Map<string, RunnableEntry[]>()
    const standalone: RunnableEntry[] = []
    const terminalCommandLanes = new Map<string, RunnableEntry[]>()
    for (const entry of runnableEntries) {
      const path = this.getFsEditTargetPath(entry.toolCall.request)
      if (path === undefined) {
        standalone.push(entry)
        continue
      }
      const bucket = fsEditGroups.get(path)
      if (bucket) {
        bucket.push(entry)
      } else {
        fsEditGroups.set(path, [entry])
      }
    }

    type BatchOutcome = {
      entries: RunnableEntry[]
      responses: ToolCallResponse[]
    }

    const batchPromises: Promise<BatchOutcome>[] = []

    for (const entry of standalone) {
      const terminalLane = this.getTerminalCommandLane(entry.toolCall.request)
      if (terminalLane !== undefined) {
        const laneEntries = terminalCommandLanes.get(terminalLane)
        if (laneEntries) {
          laneEntries.push(entry)
        } else {
          terminalCommandLanes.set(terminalLane, [entry])
        }
        continue
      }

      batchPromises.push(
        this.callToolWithDebug({
          name: entry.toolCall.request.name,
          args: getToolCallArgumentsObject(entry.toolCall.request.arguments),
          id: entry.toolCall.request.id,
          conversationId,
          conversationMessages,
          roundId: toolMessage.id,
          requireReview: this.shouldUseFsEditReview(
            entry.toolCall.request.name,
          ),
          signal,
          chatModelId,
          debugTraceId,
          workspaceScope: this.workspaceScope,
          allowedSkillPaths: this.allowedSkillPaths,
          subagentParentContext: this.subagentParentContext,
          bashApprovalMode: this.isBashToolCall(entry.toolCall.request.name)
            ? this.resolveApprovalMode(entry.toolCall.request.name)
            : undefined,
          bashReadOnly: this.isBashToolCall(entry.toolCall.request.name)
            ? this.bashReadOnly
            : undefined,
        }).then((response) => ({ entries: [entry], responses: [response] })),
      )
    }

    for (const entries of terminalCommandLanes.values()) {
      batchPromises.push(
        this.callTerminalCommandLane({
          entries,
          conversationId,
          conversationMessages,
          roundId: toolMessage.id,
          signal,
          chatModelId,
          debugTraceId,
        }),
      )
    }

    for (const [path, entries] of fsEditGroups) {
      if (entries.length === 1) {
        const entry = entries[0]
        batchPromises.push(
          this.callToolWithDebug({
            name: entry.toolCall.request.name,
            args: getToolCallArgumentsObject(entry.toolCall.request.arguments),
            id: entry.toolCall.request.id,
            conversationId,
            conversationMessages,
            roundId: toolMessage.id,
            requireReview: this.shouldUseFsEditReview(
              entry.toolCall.request.name,
            ),
            signal,
            chatModelId,
            debugTraceId,
            workspaceScope: this.workspaceScope,
            allowedSkillPaths: this.allowedSkillPaths,
            subagentParentContext: this.subagentParentContext,
          }).then((response) => ({ entries: [entry], responses: [response] })),
        )
        continue
      }

      const { mergedOperations, opCounts } =
        this.collectFsEditOperations(entries)
      const leader = entries[0]
      const mergedArgs: Record<string, unknown> = {
        path,
        operations: mergedOperations,
      }

      batchPromises.push(
        this.callToolWithDebug({
          name: leader.toolCall.request.name,
          args: mergedArgs,
          id: leader.toolCall.request.id,
          conversationId,
          conversationMessages,
          roundId: toolMessage.id,
          requireReview: this.shouldUseFsEditReview(
            leader.toolCall.request.name,
          ),
          signal,
          chatModelId,
          debugTraceId,
          workspaceScope: this.workspaceScope,
          allowedSkillPaths: this.allowedSkillPaths,
          subagentParentContext: this.subagentParentContext,
        }).then((response) => ({
          entries,
          responses: this.splitBatchedFsEditResponse({
            response,
            opCounts,
            path,
          }),
        })),
      )
    }

    const results = await Promise.allSettled(batchPromises)

    results.forEach((result) => {
      if (result.status === 'fulfilled') {
        const { entries, responses } = result.value
        entries.forEach((entry, idx) => {
          nextToolCalls[entry.index] = {
            ...nextToolCalls[entry.index],
            response: responses[idx],
          }
        })
        return
      }

      // On rejection we don't have `entries` on the rejected promise; fall
      // back to iterating all runnable entries whose response is still
      // Running and marking the first contiguous group as errored. To stay
      // robust, set every still-Running entry to Error with the rejection
      // reason — this matches the previous behavior for parallel failures
      // and is safe because only failed batches reach here.
      const message =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason)
      runnableEntries.forEach((entry) => {
        if (
          nextToolCalls[entry.index].response.status ===
          ToolCallResponseStatus.Running
        ) {
          nextToolCalls[entry.index] = {
            ...nextToolCalls[entry.index],
            response: {
              status: ToolCallResponseStatus.Error,
              error: message,
            },
          }
        }
      })
    })

    return {
      ...toolMessage,
      toolCalls: nextToolCalls,
    }
  }

  private getTerminalCommandLane(request: ToolCallRequest): string | undefined {
    try {
      const parsed = parseToolName(request.name)
      if (
        parsed.serverName !== getLocalFileToolServerName() ||
        parsed.toolName !== TERMINAL_COMMAND_TOOL_NAME
      ) {
        return undefined
      }
    } catch {
      return undefined
    }

    const args = getToolCallArgumentsObject(request.arguments)
    const sessionId = args?.session_id
    if (
      typeof sessionId === 'number' &&
      Number.isInteger(sessionId) &&
      sessionId > 0
    ) {
      return `session:${sessionId}`
    }

    return args?.background === true ? undefined : 'shared'
  }

  private async callTerminalCommandLane<
    TEntry extends { toolCall: { request: ToolCallRequest } },
  >({
    entries,
    conversationId,
    conversationMessages,
    roundId,
    signal,
    chatModelId,
    debugTraceId,
  }: {
    entries: TEntry[]
    conversationId: string
    conversationMessages?: ChatMessage[]
    roundId: string
    signal?: AbortSignal
    chatModelId?: string
    debugTraceId?: string
  }): Promise<{
    entries: TEntry[]
    responses: ToolCallResponse[]
  }> {
    const responses: ToolCallResponse[] = []
    for (const entry of entries) {
      try {
        responses.push(
          await this.callToolWithDebug({
            name: entry.toolCall.request.name,
            args: getToolCallArgumentsObject(entry.toolCall.request.arguments),
            id: entry.toolCall.request.id,
            conversationId,
            conversationMessages,
            roundId,
            requireReview: false,
            signal,
            chatModelId,
            debugTraceId,
            workspaceScope: this.workspaceScope,
            allowedSkillPaths: this.allowedSkillPaths,
            subagentParentContext: this.subagentParentContext,
          }),
        )
      } catch (error) {
        responses.push({
          status: ToolCallResponseStatus.Error,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return { entries, responses }
  }

  private async callToolWithDebug(
    params: McpToolCallParamsWithDebug,
  ): Promise<ToolCallResponse> {
    const { debugTraceId, ...rest } = params
    // Injected here rather than at each call site: every dispatch out of this
    // gateway runs under the same mode grant, so there is one place to state it.
    const toolParams: McpToolCallParams = {
      ...rest,
      capabilityForceEnabled: this.resolveCapabilityOverride(rest.name)
        ?.forceEnabled,
    }
    return captureLLMDebugOperation({
      traceId: debugTraceId,
      signal: toolParams.signal,
      transportMode: 'mcp',
      url: `mcp://${toolParams.name}`,
      method: 'callTool',
      requestBody: {
        name: toolParams.name,
        args: toolParams.args,
        id: toolParams.id,
        conversationId: toolParams.conversationId,
        roundId: toolParams.roundId,
        requireReview: toolParams.requireReview,
        chatModelId: toolParams.chatModelId,
      },
      responseContentType: 'application/json',
      run: () =>
        this.isLoadToolSchemasRequest(toolParams.name)
          ? this.callLoadToolSchemas(toolParams.args)
          : this.mcpManager.callTool(toolParams),
      getResponseBody: (response) => response,
    })
  }

  private isLoadToolSchemasRequest(toolName: string): boolean {
    try {
      const parsed = parseToolName(toolName)
      return (
        parsed.serverName === getLocalFileToolServerName() &&
        parsed.toolName === LOAD_TOOL_SCHEMAS_LOCAL_TOOL_NAME
      )
    } catch {
      return false
    }
  }

  /**
   * Disclose real schemas for named tools.
   *
   * Tool-level rather than server-level: the model already knows which tool it
   * wants (the catalog listed it by name), and pulling a whole server's
   * schemas to reach one of them just moves the context dilution out of the
   * prefix and into the message stream, where caching helps less. `servers` is
   * kept as a batch shorthand for the rarer "show me everything here" case.
   */
  private async callLoadToolSchemas(
    args?: Record<string, unknown>,
  ): Promise<ToolCallResponse> {
    const readStringArray = (
      value: unknown,
      field: string,
    ): { ok: true; values: string[] } | { ok: false; error: string } => {
      if (value === undefined) return { ok: true, values: [] }
      if (!Array.isArray(value)) {
        return { ok: false, error: `${field} must be an array of strings.` }
      }
      const values: string[] = []
      for (const entry of value) {
        if (typeof entry !== 'string') {
          return { ok: false, error: `${field} must contain only strings.` }
        }
        const trimmed = entry.trim()
        if (trimmed.length > 0 && !values.includes(trimmed)) {
          values.push(trimmed)
        }
      }
      return { ok: true, values }
    }

    const requestedTools = readStringArray(args?.tools, 'tools')
    if (!requestedTools.ok) {
      return {
        status: ToolCallResponseStatus.Error,
        error: requestedTools.error,
      }
    }
    const requestedServers = readStringArray(args?.servers, 'servers')
    if (!requestedServers.ok) {
      return {
        status: ToolCallResponseStatus.Error,
        error: requestedServers.error,
      }
    }
    if (
      requestedTools.values.length === 0 &&
      requestedServers.values.length === 0
    ) {
      return {
        status: ToolCallResponseStatus.Error,
        error:
          'Pass "tools" (fully-qualified tool names from <tool_catalog>) and/or "servers".',
      }
    }

    const available = await this.mcpManager.listAvailableTools({
      includeBuiltinTools: true,
      capabilityOverrides: this.capabilityOverrides,
    })
    const isDisclosable = async (tool: McpTool): Promise<boolean> =>
      !this.isLoadToolSchemasRequest(tool.name) &&
      this.isToolAllowed(tool.name) &&
      (await this.isOnDemandToolName(tool.name))

    const byName = new Map(available.map((tool) => [tool.name, tool]))
    const matches: McpTool[] = []
    const unknownTools: string[] = []

    for (const toolName of requestedTools.values) {
      const tool = byName.get(toolName)
      if (!tool || !(await isDisclosable(tool))) {
        unknownTools.push(toolName)
        continue
      }
      matches.push(tool)
    }

    const toolsByServer = new Map<string, McpTool[]>()
    for (const tool of available) {
      let serverName: string
      try {
        serverName = parseToolName(tool.name).serverName
      } catch {
        continue
      }
      const bucket = toolsByServer.get(serverName) ?? []
      bucket.push(tool)
      toolsByServer.set(serverName, bucket)
    }

    const loadedServers: string[] = []
    const unknownServers: string[] = []
    const emptyServers: string[] = []
    for (const serverName of requestedServers.values) {
      const serverTools = toolsByServer.get(serverName)
      if (!serverTools || serverTools.length === 0) {
        unknownServers.push(serverName)
        continue
      }
      const eligible: McpTool[] = []
      for (const tool of serverTools) {
        if (await isDisclosable(tool)) eligible.push(tool)
      }
      if (eligible.length === 0) {
        // The server exists but has nothing left to disclose (everything is
        // already always-loaded or disabled). Reported separately from
        // `unknownServers` so the model knows the name was right.
        emptyServers.push(serverName)
        continue
      }
      loadedServers.push(serverName)
      for (const tool of eligible) {
        if (!matches.some((match) => match.name === tool.name)) {
          matches.push(tool)
        }
      }
    }

    const instructionParts: string[] = []
    if (matches.length > 0) {
      instructionParts.push(
        'These tool schemas are now available. Call them through yolo_local__invoke_tool in the next turn.',
      )
    }
    if (unknownTools.length > 0) {
      instructionParts.push(
        'Unknown tool names were skipped — check <tool_catalog> for the exact spelling.',
      )
    }

    return {
      status: ToolCallResponseStatus.Success,
      data: {
        type: 'text',
        text: JSON.stringify(
          {
            tool: LOAD_TOOL_SCHEMAS_RESULT_TOOL,
            // `loadedToolNames` and `matches` are the contract
            // `tool-disclosure.ts` parses to track what has been disclosed —
            // renaming them silently breaks that tracking.
            loadedToolNames: matches.map((tool) => tool.name),
            matches: matches.map((tool) => ({
              name: tool.name,
              description: tool.description ?? '',
              parameters: {
                ...tool.inputSchema,
                properties: tool.inputSchema.properties ?? {},
              },
            })),
            unknownTools,
            loadedServers,
            emptyServers,
            unknownServers,
            instruction: instructionParts.join(' '),
          },
          null,
          2,
        ),
      },
    }
  }

  private getFsEditTargetPath(request: ToolCallRequest): string | undefined {
    try {
      const parsed = parseToolName(request.name)
      if (
        parsed.serverName !== getLocalFileToolServerName() ||
        parsed.toolName !== 'fs_edit'
      ) {
        return undefined
      }
      const args = getToolCallArgumentsObject(request.arguments)
      const rawPath = args?.path
      if (typeof rawPath !== 'string') {
        return undefined
      }
      const trimmed = rawPath.trim()
      return trimmed === '' ? undefined : trimmed
    } catch {
      return undefined
    }
  }

  private collectFsEditOperations(
    entries: Array<{ toolCall: { request: ToolCallRequest } }>,
  ): { mergedOperations: unknown[]; opCounts: number[] } {
    const mergedOperations: unknown[] = []
    const opCounts: number[] = []
    // Each fs_edit call carries one flat edit; carry its whole args object
    // through as a single operation element. getFsEditPlan's operations branch
    // parses each element via parseFlatFsEditArgs.
    for (const entry of entries) {
      const args =
        getToolCallArgumentsObject(entry.toolCall.request.arguments) ?? {}
      opCounts.push(1)
      mergedOperations.push(args)
    }
    return { mergedOperations, opCounts }
  }

  private splitBatchedFsEditResponse({
    response,
    opCounts,
    path,
  }: {
    response: ToolCallResponse
    opCounts: number[]
    path: string
  }): ToolCallResponse[] {
    // Non-success outcomes (Rejected/Aborted/Error) apply to the whole batch.
    if (response.status !== ToolCallResponseStatus.Success) {
      return opCounts.map(() => response)
    }

    // Leader keeps the full response (including editSummary / contentParts).
    // Followers get a lightweight success note that points back to the
    // unified diff for attribution.
    return opCounts.map((count, idx) => {
      if (idx === 0) {
        return response
      }
      const plural = count === 1 ? '' : 's'
      return {
        status: ToolCallResponseStatus.Success,
        data: {
          type: 'text',
          text:
            `Processed ${count} operation${plural} for ${path} as part of a batched fs_edit. ` +
            `The first fs_edit call carries the unified review outcome; do not assume this operation was accepted independently.`,
        },
      }
    })
  }

  hasPendingToolCalls(toolMessage: ChatToolMessage): boolean {
    // `AwaitingUserInput` is a paused state (model is blocked waiting for the
    // user to answer `ask_user_question`). The runtime treats it the same as
    // PendingApproval/Running so the agent loop knows the round is not yet
    // finished and will not try to continue without the user's input.
    return toolMessage.toolCalls.some((toolCall) =>
      [
        ToolCallResponseStatus.PendingApproval,
        ToolCallResponseStatus.Running,
        ToolCallResponseStatus.AwaitingUserInput,
      ].includes(toolCall.response.status),
    )
  }

  abortToolCall(id: string): boolean {
    return this.mcpManager.abortToolCall(id)
  }

  /**
   * The bash tool's effective approval tier for this run. `bypassToolApproval`
   * (the conversation-wide YOLO switch) always wins over the per-tool
   * setting, same as every other tool.
   */
  private resolveApprovalMode(toolName: string): AssistantToolApprovalMode {
    if (this.bypassToolApproval) return 'full_access'
    return getAssistantToolApprovalMode(
      {
        toolPreferences: this.toolPreferences,
        builtinCapabilityPreferences: this.builtinCapabilityPreferences,
        toolServerPreferences: this.toolServerPreferences,
        enabledToolNames: this.allowedToolNames
          ? [...this.allowedToolNames]
          : undefined,
      },
      toolName,
    )
  }

  private isBashToolCall(toolName: string): boolean {
    try {
      const parsed = parseToolName(toolName)
      return (
        parsed.serverName === getLocalFileToolServerName() &&
        parsed.toolName === BASH_TOOL_NAME
      )
    } catch {
      return false
    }
  }

  private shouldAutoExecuteTool({
    request,
    conversationId,
  }: {
    request: ToolCallRequest
    conversationId: string
  }): boolean {
    if (!this.isToolAllowed(request.name)) {
      return false
    }
    const requestArgs = getToolCallArgumentsObject(request.arguments)
    if (this.isBlockedTerminalCommand(requestArgs, request.name)) {
      return false
    }

    const approvalMode = this.resolveApprovalMode(request.name)
    const requireAutoExecution =
      approvalMode === 'full_access' ||
      this.isReadonlyTerminalCommandToolCall(requestArgs, request.name) ||
      // 'dangerous_only' never pauses the whole bash call up front — only
      // rm/mv pause, mid-script, via the dangerous-operation gate inside the
      // dispatch itself (see localFileTools.ts's bash case).
      (approvalMode === 'dangerous_only' && this.isBashToolCall(request.name))

    return this.mcpManager.isToolExecutionAllowed({
      requestToolName: request.name,
      conversationId: this.toolApprovalConversationId ?? conversationId,
      requestArgs,
      requireAutoExecution,
      capabilityForceEnabled: this.resolveCapabilityOverride(request.name)
        ?.forceEnabled,
    })
  }

  private isReadonlyTerminalCommandToolCall(
    args: Record<string, unknown> | undefined,
    toolName: string,
  ): boolean {
    try {
      const parsed = parseToolName(toolName)
      if (
        parsed.serverName !== getLocalFileToolServerName() ||
        parsed.toolName !== TERMINAL_COMMAND_TOOL_NAME
      ) {
        return false
      }
    } catch {
      return false
    }

    if (!args || typeof args.command !== 'string') {
      return false
    }
    if (args.input !== undefined || args.kill !== undefined) {
      return false
    }

    return classifyBashCommandSafety(
      args.command,
      Platform.isWin ? 'powershell' : 'posix',
    ).readonly
  }

  private isBlockedTerminalCommand(
    args: Record<string, unknown> | undefined,
    toolName: string,
  ): boolean {
    try {
      const parsed = parseToolName(toolName)
      if (
        parsed.serverName !== getLocalFileToolServerName() ||
        parsed.toolName !== TERMINAL_COMMAND_TOOL_NAME
      ) {
        return false
      }
    } catch {
      return false
    }

    if (typeof args?.command !== 'string') {
      return false
    }

    return isBlockedByCommandPrefix(
      args.command,
      this.blockedCommandPrefixes ?? DEFAULT_BLOCKED_PREFIXES,
    )
  }

  private shouldUseFsEditReview(toolName: string): boolean {
    if (this.bypassToolApproval) {
      return false
    }
    try {
      const parsed = parseToolName(toolName)
      return (
        parsed.serverName === getLocalFileToolServerName() &&
        parsed.toolName === 'fs_edit' &&
        getAssistantToolApprovalMode(
          {
            toolPreferences: this.toolPreferences,
            builtinCapabilityPreferences: this.builtinCapabilityPreferences,
            toolServerPreferences: this.toolServerPreferences,
            enabledToolNames: this.allowedToolNames
              ? [...this.allowedToolNames]
              : undefined,
          },
          toolName,
        ) === 'require_approval'
      )
    } catch {
      return false
    }
  }

  private isToolAllowed(toolName: string): boolean {
    if (!this.toolsEnabled) {
      return false
    }
    if (this.isSubagentChildRun && isSubagentBlockedToolName(toolName)) {
      return false
    }
    if (isLoadToolSchemasToolName(toolName)) {
      // Protocol-only tool injected by `selectAllowedTools` whenever anything
      // defers. It is never in `toolPreferences` or `allowedToolNames`, so the
      // user-tool gate below would otherwise reject it.
      return true
    }

    if (!this.allowedToolNames) {
      return true
    }
    if (!this.allowedToolNames.has(toolName)) {
      return false
    }

    // A capability the running mode grants unconditionally is authorized here
    // regardless of what the assistant's own preferences say — the same fact
    // `McpManager` applies to the persisted global switch, so the model's
    // tool list and this gate never disagree about what Max can run.
    if (this.resolveCapabilityOverride(toolName)?.forceEnabled) {
      return true
    }

    if (!this.toolPreferences && !this.builtinCapabilityPreferences) {
      // Non-Agent modes (`resolveChatModeRuntime`) deliberately supply no
      // preference maps, so `allowedToolNames` — already derived from the
      // assistant's enabled capabilities before the run started, narrowed to
      // what the mode's `chatModes` expose — is the only authoritative
      // source, and
      // the membership test above has already consulted it.
      //
      // Re-deriving enablement below would resolve every built-in against
      // its capability's `defaultEnabled` instead of the grant it just
      // passed, because `isAssistantToolEnabled` routes recognized built-in
      // short names through `builtinCapabilityPreferences` and ignores
      // `enabledToolNames` entirely (D9). That silently rejects every call
      // to an enabled-but-default-off capability (`js_sandbox`, both
      // context tools, `subagent_delegation`) in Ask / Quick Ask, while
      // `selectAllowedTools` still advertises it to the model.
      return true
    }

    return isAssistantToolEnabled(
      {
        toolPreferences: this.toolPreferences,
        builtinCapabilityPreferences: this.builtinCapabilityPreferences,
        enabledToolNames: [...this.allowedToolNames],
      },
      toolName,
    )
  }
}
