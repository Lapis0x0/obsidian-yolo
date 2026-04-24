import { v4 as uuidv4 } from 'uuid'

import {
  AssistantToolPreference,
  AssistantWorkspaceScope,
} from '../../types/assistant.types'
import { ChatMessage, ChatToolMessage } from '../../types/chat'
import { McpTool } from '../../types/mcp.types'
import {
  ToolCallRequest,
  ToolCallResponse,
  ToolCallResponseStatus,
  getToolCallArgumentsObject,
} from '../../types/tool-call.types'
import { getLocalFileToolServerName } from '../mcp/localFileTools'
import { McpManager } from '../mcp/mcpManager'
import { parseToolName } from '../mcp/tool-name-utils'

import {
  getAssistantToolApprovalMode,
  isAssistantToolEnabled,
} from './tool-preferences'
import { findPathOutsideScope } from './workspaceScope'

export class AgentToolGateway {
  private readonly toolsEnabled: boolean
  private readonly allowedToolNames?: Set<string>
  private readonly toolPreferences?: Record<string, AssistantToolPreference>
  private readonly workspaceScope?: AssistantWorkspaceScope
  private readonly allowedSkillIds?: Set<string>
  private readonly allowedSkillNames?: Set<string>

  constructor(
    private readonly mcpManager: McpManager,
    options?: {
      toolsEnabled?: boolean
      allowedToolNames?: string[]
      toolPreferences?: Record<string, AssistantToolPreference>
      workspaceScope?: AssistantWorkspaceScope
      allowedSkillIds?: string[]
      allowedSkillNames?: string[]
    },
  ) {
    this.toolsEnabled = options?.toolsEnabled ?? true
    this.allowedToolNames = options?.allowedToolNames
      ? new Set(options.allowedToolNames)
      : undefined
    this.toolPreferences = options?.toolPreferences
    this.workspaceScope = options?.workspaceScope
    this.allowedSkillIds = options?.allowedSkillIds
      ? new Set(options.allowedSkillIds.map((id) => id.toLowerCase()))
      : undefined
    this.allowedSkillNames = options?.allowedSkillNames
      ? new Set(options.allowedSkillNames.map((name) => name.toLowerCase()))
      : undefined
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

  async listTools({
    includeBuiltinTools,
  }: {
    includeBuiltinTools: boolean
  }): Promise<McpTool[]> {
    return this.mcpManager.listAvailableTools({ includeBuiltinTools })
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
      toolCalls: toolCallRequests.map((request) => ({
        request,
        response: {
          status:
            !this.isToolAllowed(request.name) ||
            !this.isRequestPathAllowed(request)
              ? ToolCallResponseStatus.Rejected
              : this.shouldStartToolCallRunning({ request, conversationId })
                ? ToolCallResponseStatus.Running
                : ToolCallResponseStatus.PendingApproval,
        },
      })),
    }
  }

  async executeAutoToolCalls({
    toolMessage,
    conversationId,
    conversationMessages,
    signal,
    chatModelId,
  }: {
    toolMessage: ChatToolMessage
    conversationId: string
    conversationMessages?: ChatMessage[]
    signal?: AbortSignal
    chatModelId?: string
  }): Promise<ChatToolMessage> {
    const nextToolCalls = [...toolMessage.toolCalls]
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
        this.mcpManager
          .callTool({
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
            workspaceScope: this.workspaceScope,
          })
          .then((response) => ({ entries: [entry], responses: [response] })),
      )
    }

    for (const [path, entries] of fsEditGroups) {
      if (entries.length === 1) {
        const entry = entries[0]
        batchPromises.push(
          this.mcpManager
            .callTool({
              name: entry.toolCall.request.name,
              args: getToolCallArgumentsObject(
                entry.toolCall.request.arguments,
              ),
              id: entry.toolCall.request.id,
              conversationId,
              conversationMessages,
              roundId: toolMessage.id,
              requireReview: this.shouldUseFsEditReview(
                entry.toolCall.request.name,
              ),
              signal,
              chatModelId,
              workspaceScope: this.workspaceScope,
            })
            .then((response) => ({ entries: [entry], responses: [response] })),
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
        this.mcpManager
          .callTool({
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
            workspaceScope: this.workspaceScope,
          })
          .then((response) => ({
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
    for (const entry of entries) {
      const args =
        getToolCallArgumentsObject(entry.toolCall.request.arguments) ?? {}
      let opsForEntry: unknown[]
      if (Array.isArray(args.operations)) {
        opsForEntry = args.operations
      } else if (args.operation !== undefined) {
        opsForEntry = [args.operation]
      } else {
        opsForEntry = []
      }
      opCounts.push(opsForEntry.length)
      mergedOperations.push(...opsForEntry)
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
    return toolMessage.toolCalls.some((toolCall) =>
      [
        ToolCallResponseStatus.PendingApproval,
        ToolCallResponseStatus.Running,
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

    if (this.isOpenSkillToolName(toolName)) {
      const hasAllowedSkills =
        (this.allowedSkillIds?.size ?? 0) > 0 ||
        (this.allowedSkillNames?.size ?? 0) > 0
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

      if (!this.allowedSkillIds && !this.allowedSkillNames) {
        return false
      }

      const args = getToolCallArgumentsObject(request.arguments) ?? {}
      const id = typeof args.id === 'string' ? args.id.trim().toLowerCase() : ''
      const name =
        typeof args.name === 'string' ? args.name.trim().toLowerCase() : ''

      const allowedById = Boolean(id) && Boolean(this.allowedSkillIds?.has(id))
      const allowedByName =
        Boolean(name) && Boolean(this.allowedSkillNames?.has(name))

      return allowedById || allowedByName
    } catch {
      return true
    }
  }
}
