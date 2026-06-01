import Ajv, {
  type Ajv as AjvInstance,
  type ValidateFunction as AjvValidateFunction,
} from 'ajv'
import { v4 as uuidv4 } from 'uuid'

import {
  AssistantToolPreference,
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
  getToolCallArgumentsObject,
} from '../../types/tool-call.types'
import { captureLLMDebugOperation } from '../llm/debugCapture'
import {
  ASK_USER_QUESTION_TOOL_NAME,
  LOAD_TOOL_SCHEMAS_LOCAL_TOOL_NAME,
  getLocalFileToolServerName,
  isAskUserQuestionToolName,
  validateAskUserQuestionArgs,
} from '../mcp/localFileTools'
import { McpManager } from '../mcp/mcpManager'
import { parseToolName } from '../mcp/tool-name-utils'

import {
  LOAD_TOOL_SCHEMAS_RESULT_TOOL,
  extractLoadedDeferredToolNames,
} from './tool-disclosure'
import {
  getAssistantToolApprovalMode,
  getAssistantToolDisclosureMode,
  isAssistantToolEnabled,
} from './tool-preferences'
import { isLoadToolSchemasToolName } from './tool-selection'
import { GEMINI_STUB_ARGS_JSON_FIELD, isGeminiStubApiType } from './tool-stub'
import type { AgentRunContext } from './types'
import { findPathOutsideScope } from './workspaceScope'

type McpToolCallParams = Parameters<McpManager['callTool']>[0]
type McpToolCallParamsWithDebug = McpToolCallParams & {
  debugTraceId?: string
}

export class AgentToolGateway {
  private readonly toolsEnabled: boolean
  private readonly allowedToolNames?: Set<string>
  private readonly toolPreferences?: Record<string, AssistantToolPreference>
  private readonly enableToolDisclosure: boolean
  private readonly workspaceScope?: AssistantWorkspaceScope
  private readonly allowedSkillNames?: Set<string>
  private readonly apiType?: LLMProviderApiType | null
  private readonly runContext?: AgentRunContext
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
      enableToolDisclosure?: boolean
      workspaceScope?: AssistantWorkspaceScope
      allowedSkillNames?: string[]
      apiType?: LLMProviderApiType | null
      runContext?: AgentRunContext
    },
  ) {
    this.toolsEnabled = options?.toolsEnabled ?? true
    this.allowedToolNames = options?.allowedToolNames
      ? new Set(options.allowedToolNames)
      : undefined
    this.toolPreferences = options?.toolPreferences
    this.enableToolDisclosure = options?.enableToolDisclosure ?? true
    this.workspaceScope = options?.workspaceScope
    // Canonical skill names: trim only, case-sensitive (A1). Must mirror the
    // resolver in liteSkills.ts so the permission gate agrees with lookup.
    this.allowedSkillNames = options?.allowedSkillNames
      ? new Set(options.allowedSkillNames.map((name) => name.trim()))
      : undefined
    this.apiType = options?.apiType
    this.runContext = options?.runContext
    // `strict: false` keeps ajv tolerant of MCP tool schemas that include
    // vendor-specific keywords or non-canonical types. `allErrors` lists every
    // violation in the error message so the model has enough signal to retry;
    // `useDefaults: false` keeps validation side-effect free so we never
    // rewrite the model's arguments behind its back.
    this.ajv = new Ajv({ allErrors: true, useDefaults: false })
  }

  private isOnDemandToolName(toolName: string): boolean {
    if (!this.enableToolDisclosure) {
      return false
    }
    if (isLoadToolSchemasToolName(toolName)) {
      return false
    }
    return (
      getAssistantToolDisclosureMode(
        {
          toolPreferences: this.toolPreferences,
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
   * Harness gate that runs before tool dispatch. Implements two on-demand
   * invariants that the LLM cannot enforce on its own (the registered tools
   * are stubs):
   *
   *   1. Reject calls to on-demand tools whose schemas have not been disclosed
   *      via `load_tool_schemas` in this conversation yet. Errors point the
   *      model to `load_tool_schemas` so it can self-correct in the next turn.
   *   2. For Gemini stubs, unpack the `args_json` field back into real
   *      arguments before dispatch. Then validate the unpacked payload
   *      against the real JSON Schema via ajv.
   *
   * Returns either an updated request (Gemini args_json rewritten) or a
   * structured error response that the caller substitutes for the would-be
   * tool call.
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
    if (!this.isOnDemandToolName(request.name)) {
      return { ok: true, request }
    }

    if (!loadedToolNames.has(request.name)) {
      let serverName: string | null = null
      try {
        serverName = parseToolName(request.name).serverName
      } catch {
        serverName = null
      }
      const guidance = serverName
        ? `Call yolo_local__load_tool_schemas with {"servers":["${serverName}"]} first`
        : `Call yolo_local__load_tool_schemas with the server name (the prefix before "__") first`
      return {
        ok: false,
        response: {
          status: ToolCallResponseStatus.Error,
          error:
            `Tool "${request.name}" is registered on demand and its schema has not been disclosed in this conversation yet. ` +
            `${guidance}; the next assistant turn can then call ${request.name} directly.`,
        },
      }
    }

    let normalizedArgs = getToolCallArgumentsObject(request.arguments) ?? {}
    let normalizedRequest = request

    if (isGeminiStubApiType(this.apiType)) {
      const raw = normalizedArgs[GEMINI_STUB_ARGS_JSON_FIELD]
      if (typeof raw !== 'string') {
        return {
          ok: false,
          response: {
            status: ToolCallResponseStatus.Error,
            error: `Tool "${request.name}" is an on-demand tool. On Gemini, its arguments must be passed as a JSON-encoded string in the "${GEMINI_STUB_ARGS_JSON_FIELD}" field; received a non-string value instead.`,
          },
        }
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        return {
          ok: false,
          response: {
            status: ToolCallResponseStatus.Error,
            error: `Tool "${request.name}" received an invalid JSON payload in "${GEMINI_STUB_ARGS_JSON_FIELD}": ${error instanceof Error ? error.message : String(error)}.`,
          },
        }
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
          ok: false,
          response: {
            status: ToolCallResponseStatus.Error,
            error: `Tool "${request.name}" expected an object payload in "${GEMINI_STUB_ARGS_JSON_FIELD}", received ${Array.isArray(parsed) ? 'an array' : typeof parsed}.`,
          },
        }
      }
      normalizedArgs = parsed as Record<string, unknown>
      normalizedRequest = {
        ...request,
        arguments: createCompleteToolCallArguments({ value: normalizedArgs }),
      }
    }

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

    return { ok: true, request: normalizedRequest }
  }

  private isRequestPathAllowed(request: ToolCallRequest): boolean {
    if (!this.workspaceScope?.enabled) return true
    try {
      const parsed = parseToolName(request.name)
      if (parsed.serverName !== getLocalFileToolServerName()) return true
      const args = getToolCallArgumentsObject(request.arguments)
      return (
        findPathOutsideScope(parsed.toolName, args, this.workspaceScope) ===
        null
      )
    } catch {
      return true
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
    // ask_user_question is exclusive within a single LLM turn. Detect this
    // up-front so we can force all sibling outcomes accordingly before falling
    // back to the per-tool routing for non-ask cases.
    const askIndices: number[] = []
    toolCallRequests.forEach((request, index) => {
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
      toolCalls: toolCallRequests.map((request, index) => ({
        request,
        response: this.resolveInitialResponse({
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
      })),
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

    if (
      !this.isToolAllowed(request.name) ||
      !this.isRequestPathAllowed(request)
    ) {
      return { status: ToolCallResponseStatus.Rejected }
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

    return this.shouldStartToolCallRunning({ request, conversationId })
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
    // Harness pre-pass: on-demand stubs let any call through provider-side
    // validation, so we must enforce "schema previously disclosed" and (for
    // Gemini) unpack the `args_json` smuggle field + run real-schema ajv
    // validation before dispatch. Failures convert the call's status to
    // Error with guidance pointing back to `load_tool_schemas`.
    const loadedToolNames = extractLoadedDeferredToolNames({
      messages: conversationMessages ?? [],
      compaction: conversationCompaction ?? null,
    })
    for (let i = 0; i < nextToolCalls.length; i += 1) {
      const entry = nextToolCalls[i]
      if (entry.response.status !== ToolCallResponseStatus.Running) {
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
          runContext: this.runContext,
        }).then((response) => ({ entries: [entry], responses: [response] })),
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
          runContext: this.runContext,
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

  private async callToolWithDebug(
    params: McpToolCallParamsWithDebug,
  ): Promise<ToolCallResponse> {
    const { debugTraceId, ...toolParams } = params
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

  private async callLoadToolSchemas(
    args?: Record<string, unknown>,
  ): Promise<ToolCallResponse> {
    const rawServers = args?.servers
    if (!Array.isArray(rawServers) || rawServers.length === 0) {
      return {
        status: ToolCallResponseStatus.Error,
        error: 'servers must be a non-empty array of MCP server names.',
      }
    }
    const requestedServers: string[] = []
    for (const entry of rawServers) {
      if (typeof entry !== 'string') {
        return {
          status: ToolCallResponseStatus.Error,
          error: 'servers must contain only strings.',
        }
      }
      const trimmed = entry.trim()
      if (trimmed.length === 0) continue
      if (!requestedServers.includes(trimmed)) {
        requestedServers.push(trimmed)
      }
    }
    if (requestedServers.length === 0) {
      return {
        status: ToolCallResponseStatus.Error,
        error: 'servers must contain at least one non-empty MCP server name.',
      }
    }

    const tools = await this.mcpManager.listAvailableTools({
      includeBuiltinTools: true,
    })
    const toolsByServer = new Map<string, McpTool[]>()
    for (const tool of tools) {
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

    const matches: McpTool[] = []
    const loadedServers: string[] = []
    const unknown: string[] = []
    const emptyServers: string[] = []
    for (const serverName of requestedServers) {
      const serverTools = toolsByServer.get(serverName)
      if (!serverTools || serverTools.length === 0) {
        unknown.push(serverName)
        continue
      }
      const eligible = serverTools.filter(
        (tool) =>
          !this.isLoadToolSchemasRequest(tool.name) &&
          this.isToolAllowed(tool.name) &&
          this.isOnDemandToolName(tool.name),
      )
      if (eligible.length === 0) {
        // Server exists but has nothing left to disclose (all tools already
        // always-loaded or disabled). Report separately from `unknownServers`
        // so the model knows the name was right and won't retry.
        emptyServers.push(serverName)
        continue
      }
      loadedServers.push(serverName)
      for (const tool of eligible) {
        matches.push(tool)
      }
    }

    const instructionParts: string[] = []
    if (matches.length > 0) {
      instructionParts.push(
        'These tool schemas are now available. Call the loaded tools directly in the next turn.',
      )
    }
    if (emptyServers.length > 0) {
      instructionParts.push(
        `Servers [${emptyServers.join(', ')}] were recognized but have no on-demand tools to load (all their tools are already in context or disabled).`,
      )
    }
    if (unknown.length > 0) {
      instructionParts.push(
        `Servers [${unknown.join(', ')}] are not registered or have no tools available.`,
      )
    }
    if (instructionParts.length === 0) {
      instructionParts.push(
        'No on-demand tools matched the requested MCP servers.',
      )
    }

    return {
      status: ToolCallResponseStatus.Success,
      data: {
        type: 'text',
        text: JSON.stringify(
          {
            tool: LOAD_TOOL_SCHEMAS_RESULT_TOOL,
            loadedServers,
            loadedToolNames: matches.map((tool) => tool.name),
            matches: matches.map((tool) => ({
              name: tool.name,
              description: tool.description ?? '',
              parameters: {
                ...tool.inputSchema,
                properties: tool.inputSchema.properties ?? {},
              },
            })),
            emptyServers,
            unknownServers: unknown,
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
            `Applied ${count} operation${plural} to ${path} as part of a batched fs_edit. ` +
            `The first fs_edit call in this batch carries the unified diff.`,
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
    if (!this.isSkillPermissionAllowed(request)) {
      return false
    }

    return this.mcpManager.isToolExecutionAllowed({
      requestToolName: request.name,
      conversationId,
      requestArgs: getToolCallArgumentsObject(request.arguments),
      requireAutoExecution:
        getAssistantToolApprovalMode(
          {
            toolPreferences: this.toolPreferences,
            enabledToolNames: this.allowedToolNames
              ? [...this.allowedToolNames]
              : undefined,
          },
          request.name,
          { jsSandboxSettings: this.mcpManager.getJsSandboxSettings() },
        ) === 'full_access',
    })
  }

  private shouldStartToolCallRunning({
    request,
    conversationId,
  }: {
    request: ToolCallRequest
    conversationId: string
  }): boolean {
    if (!this.isToolAllowed(request.name)) {
      return false
    }
    if (!this.isSkillPermissionAllowed(request)) {
      return false
    }

    return (
      this.shouldAutoExecuteTool({ request, conversationId }) ||
      this.shouldUseFsEditReview(request.name)
    )
  }

  private shouldUseFsEditReview(toolName: string): boolean {
    try {
      const parsed = parseToolName(toolName)
      return (
        parsed.serverName === getLocalFileToolServerName() &&
        parsed.toolName === 'fs_edit' &&
        getAssistantToolApprovalMode(
          {
            toolPreferences: this.toolPreferences,
            enabledToolNames: this.allowedToolNames
              ? [...this.allowedToolNames]
              : undefined,
          },
          toolName,
          { jsSandboxSettings: this.mcpManager.getJsSandboxSettings() },
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
    if (isLoadToolSchemasToolName(toolName)) {
      // Loader is a protocol-only tool injected by `selectAllowedTools` when
      // disclosure is on. It is never in `toolPreferences` or
      // `allowedToolNames`, so the user-tool gate below would reject it.
      return this.enableToolDisclosure
    }

    if (this.isOpenSkillToolName(toolName)) {
      const hasAllowedSkills = (this.allowedSkillNames?.size ?? 0) > 0
      if (!hasAllowedSkills) {
        return false
      }
    }

    if (!this.allowedToolNames) {
      return true
    }
    if (!this.allowedToolNames.has(toolName)) {
      return false
    }

    return isAssistantToolEnabled(
      {
        toolPreferences: this.toolPreferences,
        enabledToolNames: [...this.allowedToolNames],
      },
      toolName,
    )
  }

  private isOpenSkillToolName(toolName: string): boolean {
    try {
      const parsed = parseToolName(toolName)
      return (
        parsed.serverName === getLocalFileToolServerName() &&
        parsed.toolName === 'open_skill'
      )
    } catch {
      return false
    }
  }

  private isSkillPermissionAllowed(request: ToolCallRequest): boolean {
    try {
      const parsed = parseToolName(request.name)
      if (
        parsed.serverName !== getLocalFileToolServerName() ||
        parsed.toolName !== 'open_skill'
      ) {
        return true
      }

      if (!this.allowedSkillNames) {
        return false
      }

      const args = getToolCallArgumentsObject(request.arguments) ?? {}
      const name = typeof args.name === 'string' ? args.name.trim() : ''

      return Boolean(name) && Boolean(this.allowedSkillNames.has(name))
    } catch {
      return true
    }
  }
}
