import type {
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
  SDKMessage,
  SDKUserMessage,
} from '@yolo/claude-agent-sdk-runtime'
import { v4 as uuidv4 } from 'uuid'

import type {
  ChatAssistantMessage,
  ChatMessage,
  ChatToolMessage,
} from '../../../types/chat'
import type { ContentPart } from '../../../types/llm/request'
import {
  type ToolCallRequest,
  type ToolCallResponse,
  ToolCallResponseStatus,
  createPartialToolCallArguments,
} from '../../../types/tool-call.types'
import { ReasoningPhaseTracker } from '../../../utils/chat/reasoningPhaseTracker'
import {
  mapClaudeGetContextUsage,
  mapClaudeResultContextUsage,
  mapClaudeResultResponseUsage,
} from '../context-usage'
import { assertCliRuntimeAvailable } from '../desktop'
import { includeActiveCliModel } from '../model-catalog'
import {
  type CliChatMode,
  resolveClaudePermissionMode,
} from '../permission-profile'
import { createCliToolCallRequest } from '../tool-call'
import type {
  CliApprovalResponse,
  CliPermissionProfileUpdate,
  CliQuestionResponse,
  CliRewriteTurnInput,
  CliRuntime,
  CliRuntimeConfiguration,
  CliRuntimeConfigurationUpdate,
  CliRuntimeEvent,
  CliRuntimeEventListener,
  CliRuntimeMcpServerStatus,
  CliRuntimeReadyInput,
  CliRuntimeSkill,
  CliSessionHydration,
  CliSessionRef,
  CliSubagentRef,
  CliTurnInput,
} from '../types'

import {
  CLAUDE_ASK_USER_QUESTION_TOOL,
  convertYoloAnswerPayloadToClaude,
  mapClaudeAskUserQuestionInput,
} from './askUserQuestion'
import { AsyncPushQueue } from './asyncQueue'
import {
  CLAUDE_BASH_TOOL,
  extractTextContent,
  extractThinkingContent,
  extractToolResults,
  extractToolUses,
  hydrateClaudeSessionMessages,
  hydrateClaudeSessionTranscript,
  parseClaudeTaskNotification,
  reconcileFinalText,
  toToolCallRequest,
} from './messages'
import { resolveClaudeProcessSupport } from './process'
import { loadClaudeAgentSdk } from './sdk-loader'
import type {
  ClaudeProcessSupportResolver,
  ClaudeSdkLoader,
  ClaudeSdkModule,
  ClaudeSdkQuery,
} from './types'

type PendingPermission = {
  requestId: string
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
  suggestions?: PermissionUpdate[]
  kind: 'approval' | 'question'
  resolve: (result: PermissionResult) => void
  settled: boolean
}

type ToolState = {
  request: ToolCallRequest
  response: ToolCallResponse
}

type StreamedToolInput = {
  id: string
  name: string
  rawInput: string
  parentCallId?: string
}

export type ClaudeCliRuntimeOptions = {
  vaultPath: string
  /** Read at each session start so path overrides apply without a restart. */
  getConfiguredCliPath?: () => string | undefined
  loadSdk?: ClaudeSdkLoader
  resolveProcessSupport?: ClaudeProcessSupportResolver
  /** Product chat mode mapped into Claude SDK permissionMode at session start. */
  cliChatMode?: CliChatMode
  /** When true with agent mode, maps to bypassPermissions. */
  yoloEnabled?: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const CLAUDE_MCP_SERVER_STATUSES = new Set<CliRuntimeMcpServerStatus['status']>(
  ['connected', 'failed', 'needs-auth', 'pending', 'disabled'],
)

const toCliMcpServerStatus = (status: {
  name: string
  status: string
  error?: string
  scope?: string
  tools?: Array<{ name: string; description?: string }>
}): CliRuntimeMcpServerStatus => ({
  name: status.name,
  status: CLAUDE_MCP_SERVER_STATUSES.has(
    status.status as CliRuntimeMcpServerStatus['status'],
  )
    ? (status.status as CliRuntimeMcpServerStatus['status'])
    : 'unknown',
  ...(status.tools ? { toolCount: status.tools.length } : {}),
  ...(status.scope ? { scope: status.scope } : {}),
  ...(status.error ? { errorMessage: status.error } : {}),
  readOnly: false,
})

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const toVaultRelativePath = (vaultPath: string, filePath: string): string => {
  const normalizedVaultPath = vaultPath.replace(/\\/g, '/').replace(/\/$/, '')
  const normalizedFilePath = filePath.replace(/\\/g, '/')
  return normalizedFilePath.startsWith(`${normalizedVaultPath}/`)
    ? normalizedFilePath.slice(normalizedVaultPath.length + 1)
    : normalizedFilePath
}

const cloneToolMessage = (message: ChatToolMessage): ChatToolMessage => ({
  ...message,
  toolCalls: message.toolCalls.map((toolCall) => ({
    request: {
      ...toolCall.request,
      arguments: toolCall.request.arguments
        ? { ...toolCall.request.arguments }
        : undefined,
    },
    response: { ...toolCall.response },
  })),
})

const cloneAssistantMessage = (
  message: ChatAssistantMessage,
): ChatAssistantMessage => ({
  ...message,
  toolCallRequests: message.toolCallRequests?.map((request) => ({
    ...request,
    arguments: request.arguments ? { ...request.arguments } : undefined,
  })),
  metadata: message.metadata ? { ...message.metadata } : undefined,
})

const toSessionPermissionUpdates = (
  toolName: string,
  suggestions?: PermissionUpdate[],
): PermissionUpdate[] => {
  const updates = (suggestions ?? []).map((suggestion) => ({
    ...suggestion,
    destination: 'session',
  })) as PermissionUpdate[]
  const hasRuleUpdate = updates.some(
    (update) => update.type === 'addRules' || update.type === 'replaceRules',
  )
  if (!hasRuleUpdate) {
    updates.unshift({
      type: 'addRules',
      rules: [{ toolName }],
      behavior: 'allow',
      destination: 'session',
    })
  }
  return updates
}

const normalizeAskUserQuestionInput = (
  input: Record<string, unknown>,
): Record<string, unknown> => {
  if (!Array.isArray(input.questions)) return input
  return {
    ...input,
    questions: input.questions.map((question) =>
      isRecord(question) && !('isOther' in question)
        ? { ...question, isOther: true }
        : question,
    ),
  }
}

const contentPartToClaudeBlock = (
  part: ContentPart,
): Record<string, unknown> => {
  if (part.type === 'text') return part
  if (part.type === 'document') {
    return {
      type: 'document',
      source: {
        type: 'base64',
        media_type: part.mediaType,
        data: part.data,
      },
      title: part.name,
    }
  }

  const dataUrl = part.image_url.url.match(
    /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/,
  )
  if (dataUrl) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: dataUrl[1],
        data: dataUrl[2].replace(/[\r\n]/g, ''),
      },
    }
  }
  return {
    type: 'image',
    source: { type: 'url', url: part.image_url.url },
  }
}

const toSdkUserMessage = (
  content: string | ContentPart[],
  sessionId?: string,
  userMessageId: string = uuidv4(),
): SDKUserMessage =>
  ({
    type: 'user',
    message: {
      role: 'user',
      content:
        typeof content === 'string'
          ? content
          : content.map(contentPartToClaudeBlock),
    },
    parent_tool_use_id: null,
    uuid: userMessageId,
    ...(sessionId ? { session_id: sessionId } : {}),
  }) as SDKUserMessage

export class ClaudeCliRuntime implements CliRuntime {
  readonly runtimeId = 'claude-code' as const

  private readonly vaultPath: string
  private readonly getConfiguredCliPath?: () => string | undefined
  private readonly loadSdk: ClaudeSdkLoader
  private readonly resolveProcessSupport: ClaudeProcessSupportResolver
  private readonly listeners = new Set<CliRuntimeEventListener>()
  private readonly pendingPermissions = new Map<string, PendingPermission>()
  private readonly tools = new Map<string, ToolState>()
  private readonly streamedToolInputs = new Map<number, StreamedToolInput>()

  private sdkPromise?: Promise<ClaudeSdkModule>
  private query?: ClaudeSdkQuery
  private inputQueue?: AsyncPushQueue<SDKUserMessage>
  private consumePromise?: Promise<void>
  private readyKey?: string
  private currentSessionRef?: CliSessionRef
  private publishedSessionRef?: CliSessionRef
  private models: CliRuntimeConfiguration['models'] = []
  private modelId: string | null = null
  private reportedModelId: string | null = null
  private reasoningEffort: string | null = null
  private cliChatMode: CliChatMode
  private yoloEnabled: boolean
  private activeAssistant?: ChatAssistantMessage
  private activeAssistantKey?: string
  private reasoningTracker?: ReasoningPhaseTracker
  private activeUserMessageId?: string
  private disposed = false
  private resetting = false
  private cancelRequested = false

  constructor(options: ClaudeCliRuntimeOptions) {
    this.vaultPath = options.vaultPath
    this.getConfiguredCliPath = options.getConfiguredCliPath
    this.loadSdk = options.loadSdk ?? loadClaudeAgentSdk
    this.resolveProcessSupport =
      options.resolveProcessSupport ??
      (() =>
        resolveClaudeProcessSupport({
          configuredCliPath: this.getConfiguredCliPath?.(),
        }))
    this.cliChatMode = options.cliChatMode ?? 'agent'
    this.yoloEnabled = options.yoloEnabled ?? false
  }

  async openSession(ref: CliSessionRef): Promise<CliSessionHydration> {
    this.assertUsable()
    this.assertClaudeRef(ref)
    const sdk = await this.getSdk()
    const messages = await sdk.getSessionMessages(ref.nativeSessionId)
    return { ref, ...hydrateClaudeSessionTranscript(messages) }
  }

  async readSubagent(ref: CliSubagentRef): Promise<readonly ChatMessage[]> {
    this.assertUsable()
    this.assertClaudeRef(ref.parentSessionRef)
    const sdk = await this.getSdk()
    const messages = await sdk.getSubagentMessages(
      ref.parentSessionRef.nativeSessionId,
      ref.subagentId,
    )
    return hydrateClaudeSessionMessages(messages)
  }

  async ensureReady(input: CliRuntimeReadyInput): Promise<void> {
    this.assertUsable()
    if (input.sessionRef) this.assertClaudeRef(input.sessionRef)

    const [sdk, processSupport] = await Promise.all([
      this.getSdk(),
      this.resolveProcessSupport(),
    ])
    const readyConfiguration = {
      sessionId: input.sessionRef?.nativeSessionId,
      cliPath: processSupport.cliPath,
    }
    const readyKey = JSON.stringify(readyConfiguration)
    if (this.query && this.readyKey === readyKey) return

    const sessionRef = input.sessionRef ?? {
      runtimeId: 'claude-code' as const,
      nativeSessionId: uuidv4(),
    }
    await this.startSession({
      sdk,
      processSupport,
      sessionRef,
      ...(input.sessionRef
        ? { resumeSessionId: input.sessionRef.nativeSessionId }
        : {}),
      readyKey: JSON.stringify({
        ...readyConfiguration,
        sessionId: sessionRef.nativeSessionId,
      }),
    })
  }

  private async startSession({
    sdk,
    processSupport,
    sessionRef,
    resumeSessionId,
    resumeSessionAt,
    forkSession = false,
    readyKey,
  }: {
    sdk: ClaudeSdkModule
    processSupport: Awaited<ReturnType<ClaudeProcessSupportResolver>>
    sessionRef: CliSessionRef
    resumeSessionId?: string
    resumeSessionAt?: string
    forkSession?: boolean
    readyKey: string
  }): Promise<void> {
    await this.resetQuery()
    this.currentSessionRef = sessionRef
    this.publishedSessionRef = undefined
    this.readyKey = readyKey
    this.inputQueue = new AsyncPushQueue<SDKUserMessage>()
    const nativeAbortController = processSupport.createAbortController()
    const originalAbortController = globalThis.AbortController
    const NodeRealmAbortController = class {
      private readonly controller = processSupport.createAbortController()
      readonly signal = this.controller.signal

      abort(reason?: unknown): void {
        this.controller.abort(reason)
      }
    }
    try {
      // The SDK creates one additional controller synchronously for its
      // forwarded-abort channel. In Electron's renderer, the ambient
      // AbortController belongs to Chromium and node:events rejects its
      // signal. Keep the substitution scoped to SDK construction.
      globalThis.AbortController =
        NodeRealmAbortController as unknown as typeof AbortController
      const permissionMode = resolveClaudePermissionMode(
        this.cliChatMode,
        this.yoloEnabled,
      )
      this.query = sdk.query({
        prompt: this.inputQueue,
        options: {
          abortController: nativeAbortController,
          cwd: this.vaultPath,
          pathToClaudeCodeExecutable: processSupport.cliPath,
          env: processSupport.env,
          spawnClaudeCodeProcess: processSupport.spawnClaudeCodeProcess,
          includePartialMessages: true,
          enableFileCheckpointing: true,
          permissionMode,
          // Always allow so mid-session YOLO hot-updates can call
          // setPermissionMode('bypassPermissions') without restarting.
          allowDangerouslySkipPermissions: true,
          canUseTool: this.createCanUseTool(),
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
          },
          ...(resumeSessionId
            ? {
                resume: resumeSessionId,
                ...(resumeSessionAt ? { resumeSessionAt } : {}),
                ...(forkSession
                  ? {
                      forkSession: true,
                      sessionId: sessionRef.nativeSessionId,
                    }
                  : {}),
              }
            : { sessionId: sessionRef.nativeSessionId }),
        },
      })
    } finally {
      globalThis.AbortController = originalAbortController
    }
    const query = this.query
    this.consumePromise = this.consume(query)
    try {
      const initialization = await query.initializationResult()
      const supportedModels =
        initialization.models.length > 0
          ? initialization.models
          : await query.supportedModels()
      const matchedActiveModel = this.reportedModelId
        ? supportedModels.find(
            (model) =>
              model.value === this.reportedModelId ||
              model.resolvedModel === this.reportedModelId,
          )
        : undefined
      this.models = includeActiveCliModel(
        supportedModels.map((model) => ({
          id: model.value,
          label:
            model.value === 'default' && model.resolvedModel
              ? model.resolvedModel
              : model.displayName,
          ...(model.description ? { description: model.description } : {}),
          reasoningEfforts: (model.supportedEffortLevels ?? []).map((id) => ({
            id,
          })),
          isDefault: model.value === 'default',
        })),
        this.reportedModelId,
        (model, modelId) =>
          model.id === modelId ||
          supportedModels.some(
            (reported) =>
              reported.value === model.id && reported.resolvedModel === modelId,
          ),
      )
      this.modelId =
        matchedActiveModel?.value ??
        this.reportedModelId ??
        this.models.find((model) => model.isDefault)?.id ??
        this.models[0]?.id ??
        null
      this.reasoningEffort = null
      this.publishSessionBound(sessionRef)
      if (resumeSessionId) {
        void this.emitRestoredContextUsage(query)
      }
    } catch (error) {
      await this.resetQuery()
      throw error
    }
  }

  async getConfiguration(): Promise<CliRuntimeConfiguration> {
    this.assertUsable()
    if (!this.query) throw new Error('Claude CLI runtime is not ready.')
    return {
      models: this.models,
      modelId: this.modelId,
      reasoningEffort: this.reasoningEffort,
    }
  }

  async listSkills(): Promise<CliRuntimeSkill[]> {
    this.assertUsable()
    const query = this.query
    if (!query) throw new Error('Claude CLI runtime is not ready.')
    const commands = query.reloadSkills
      ? (await query.reloadSkills()).skills
      : query.supportedCommands
        ? await query.supportedCommands()
        : (await query.initializationResult()).commands
    return commands.map((command) => ({
      name: command.name,
      description: command.description,
      path: `claude-code://skills/${encodeURIComponent(command.name)}`,
    }))
  }

  /**
   * Best-effort hot-reload of plugin state into the live session, used by the
   * plugin manager after install/enable/disable/uninstall so the running CLI
   * session picks up the change without a restart. Silently no-ops when the
   * runtime is not ready or the SDK build predates `reloadPlugins`.
   */
  async reloadPlugins(): Promise<void> {
    this.assertUsable()
    const query = this.query
    if (!query?.reloadPlugins) return
    await query.reloadPlugins()
  }

  /**
   * Current status of all configured MCP servers, including plugin-provided
   * ones. Returns an empty list when the SDK build predates the query
   * method rather than throwing, since this is a best-effort status view.
   */
  async mcpServerStatus(): Promise<CliRuntimeMcpServerStatus[]> {
    this.assertUsable()
    const query = this.query
    if (!query) throw new Error('Claude CLI runtime is not ready.')
    if (!query.mcpServerStatus) return []
    const statuses = await query.mcpServerStatus()
    return statuses.map(toCliMcpServerStatus)
  }

  async toggleMcpServer(name: string, enabled: boolean): Promise<void> {
    this.assertUsable()
    const query = this.query
    if (!query) throw new Error('Claude CLI runtime is not ready.')
    if (!query.toggleMcpServer) {
      throw new Error(
        'This Claude Code build does not support toggling MCP servers.',
      )
    }
    await query.toggleMcpServer(name, enabled)
  }

  async reconnectMcpServer(name: string): Promise<void> {
    this.assertUsable()
    const query = this.query
    if (!query) throw new Error('Claude CLI runtime is not ready.')
    if (!query.reconnectMcpServer) {
      throw new Error(
        'This Claude Code build does not support reconnecting MCP servers.',
      )
    }
    await query.reconnectMcpServer(name)
  }

  async compact(): Promise<void> {
    this.assertUsable()
    if (!this.query || !this.inputQueue) {
      throw new Error('Claude CLI runtime is not ready.')
    }
    this.activeAssistant = undefined
    this.activeAssistantKey = undefined
    this.reasoningTracker = undefined
    this.streamedToolInputs.clear()
    this.cancelRequested = false
    this.activeUserMessageId = undefined
    this.inputQueue.push(
      toSdkUserMessage('/compact', this.currentSessionRef?.nativeSessionId),
    )
  }

  async updateConfiguration(
    update: CliRuntimeConfigurationUpdate,
  ): Promise<CliRuntimeConfiguration> {
    this.assertUsable()
    const query = this.query
    if (!query) throw new Error('Claude CLI runtime is not ready.')

    if ('modelId' in update) {
      const modelId = update.modelId ?? null
      await query.setModel(modelId ?? undefined)
      this.modelId = modelId
      const selectedModel = modelId
        ? this.models.find((model) => model.id === modelId)
        : undefined
      if (
        this.reasoningEffort &&
        selectedModel &&
        !selectedModel.reasoningEfforts.some(
          (effort) => effort.id === this.reasoningEffort,
        )
      ) {
        await query.applyFlagSettings({ effortLevel: null })
        this.reasoningEffort = null
      }
    }

    if ('reasoningEffort' in update) {
      const reasoningEffort = update.reasoningEffort ?? null
      await query.applyFlagSettings({
        effortLevel: reasoningEffort as
          | 'low'
          | 'medium'
          | 'high'
          | 'xhigh'
          | 'max'
          | null,
      })
      this.reasoningEffort = reasoningEffort
    }
    return this.getConfiguration()
  }

  async updatePermissionProfile(
    update: CliPermissionProfileUpdate,
  ): Promise<void> {
    this.assertUsable()
    this.cliChatMode = update.mode
    this.yoloEnabled = update.yoloEnabled
    const query = this.query
    if (!query) return
    await query.setPermissionMode(
      resolveClaudePermissionMode(update.mode, update.yoloEnabled),
    )
  }

  async sendTurn(input: CliTurnInput): Promise<void> {
    this.assertUsable()
    if (!this.query || !this.inputQueue) {
      throw new Error('Claude CLI runtime is not ready.')
    }
    if (input.sessionRef) {
      this.assertClaudeRef(input.sessionRef)
      if (
        this.currentSessionRef &&
        input.sessionRef.nativeSessionId !==
          this.currentSessionRef.nativeSessionId
      ) {
        throw new Error('Claude turn does not match the active native session.')
      }
    }

    this.activeAssistant = undefined
    this.activeAssistantKey = undefined
    this.reasoningTracker = undefined
    this.streamedToolInputs.clear()
    this.cancelRequested = false
    const userMessageId = input.userMessageId ?? uuidv4()
    this.activeUserMessageId = userMessageId
    this.emit({ type: 'run_state', state: 'running' })
    this.inputQueue.push(
      toSdkUserMessage(
        input.content,
        this.currentSessionRef?.nativeSessionId,
        userMessageId,
      ),
    )
  }

  async rewriteTurn(input: CliRewriteTurnInput): Promise<void> {
    this.assertUsable()
    if (!this.currentSessionRef || !this.query) {
      throw new Error('Claude CLI runtime is not ready.')
    }
    this.assertClaudeRef(input.sessionRef)
    if (
      input.sessionRef.nativeSessionId !==
      this.currentSessionRef.nativeSessionId
    ) {
      throw new Error('Claude rewrite does not match the active session.')
    }

    const sdk = await this.getSdk()
    const messages = await sdk.getSessionMessages(
      this.currentSessionRef.nativeSessionId,
    )
    const targetIndex = messages.findIndex(
      (message) =>
        message.parent_tool_use_id === null &&
        message.type === 'user' &&
        message.uuid === input.sourceUserMessageId,
    )
    if (targetIndex < 0) {
      throw new Error('The selected Claude user message no longer exists.')
    }
    const resumeMessage = messages
      .slice(0, targetIndex)
      .reverse()
      .find((message) => message.parent_tool_use_id === null)
    const previousModelId = this.modelId
    const previousReasoningEffort = this.reasoningEffort
    const sourceSessionId = this.currentSessionRef.nativeSessionId
    const nextSessionRef: CliSessionRef = {
      runtimeId: 'claude-code',
      nativeSessionId: uuidv4(),
    }
    const processSupport = await this.resolveProcessSupport()
    await this.startSession({
      sdk,
      processSupport,
      sessionRef: nextSessionRef,
      ...(resumeMessage
        ? {
            resumeSessionId: sourceSessionId,
            resumeSessionAt: resumeMessage.uuid,
            forkSession: true,
          }
        : {}),
      readyKey: JSON.stringify({
        sessionId: nextSessionRef.nativeSessionId,
        cliPath: processSupport.cliPath,
      }),
    })
    if (previousModelId !== null) {
      await this.query.setModel(previousModelId)
      this.modelId = previousModelId
    }
    if (previousReasoningEffort !== null) {
      await this.query.applyFlagSettings({
        effortLevel: previousReasoningEffort as
          | 'low'
          | 'medium'
          | 'high'
          | 'xhigh'
          | 'max',
      })
      this.reasoningEffort = previousReasoningEffort
    }
    await this.sendTurn({ ...input, sessionRef: nextSessionRef })
  }

  async cancel(): Promise<void> {
    this.assertUsable()
    this.cancelRequested = true
    this.settleAllPending({
      behavior: 'deny',
      message: 'User interrupted the Claude turn.',
      interrupt: true,
      decisionClassification: 'user_reject',
    })
    if (this.query) {
      await this.query.interrupt()
    }
    this.markActiveAssistant('aborted')
    for (const [toolUseId, tool] of this.tools) {
      if (
        tool.response.status === ToolCallResponseStatus.Running ||
        tool.response.status === ToolCallResponseStatus.PendingApproval ||
        tool.response.status === ToolCallResponseStatus.AwaitingUserInput
      ) {
        this.upsertTool(toolUseId, {
          status: ToolCallResponseStatus.Aborted,
        })
      }
    }
    this.emit({ type: 'run_state', state: 'aborted' })
  }

  async respondApproval(response: CliApprovalResponse): Promise<boolean> {
    const pending = this.pendingPermissions.get(response.requestId)
    if (!pending || pending.kind !== 'approval' || pending.settled) return false

    if (response.decision === 'reject') {
      this.settlePending(pending, {
        behavior: 'deny',
        message: 'User denied this action.',
        toolUseID: pending.toolUseId,
        decisionClassification: 'user_reject',
      })
      this.upsertTool(pending.toolUseId, {
        status: ToolCallResponseStatus.Rejected,
        reason: 'User denied this action.',
      })
      this.emitPendingRunStateOrRunning()
      return true
    }

    this.settlePending(pending, {
      behavior: 'allow',
      updatedInput: pending.input,
      toolUseID: pending.toolUseId,
      ...(response.decision === 'approve_for_session'
        ? {
            updatedPermissions: toSessionPermissionUpdates(
              pending.toolName,
              pending.suggestions,
            ),
          }
        : {}),
      decisionClassification:
        response.decision === 'approve_for_session'
          ? 'user_permanent'
          : 'user_temporary',
    })
    this.upsertTool(pending.toolUseId, {
      status: ToolCallResponseStatus.Running,
    })
    this.emitPendingRunStateOrRunning()
    return true
  }

  async respondQuestion(response: CliQuestionResponse): Promise<boolean> {
    const pending = this.pendingPermissions.get(response.requestId)
    if (!pending || pending.kind !== 'question' || pending.settled) return false

    if (response.answer === null || response.answer === undefined) {
      this.settlePending(pending, {
        behavior: 'deny',
        message: 'User declined to answer.',
        interrupt: true,
        toolUseID: pending.toolUseId,
        decisionClassification: 'user_reject',
      })
      this.upsertTool(pending.toolUseId, {
        status: ToolCallResponseStatus.Rejected,
        reason: 'User declined to answer.',
      })
      return true
    }

    const converted = convertYoloAnswerPayloadToClaude({
      payload: response.answer,
      nativeInput: pending.input,
    })
    if (!converted.ok) {
      this.settlePending(pending, {
        behavior: 'deny',
        message: converted.error,
        interrupt: true,
        toolUseID: pending.toolUseId,
      })
      this.upsertTool(pending.toolUseId, {
        status: ToolCallResponseStatus.Error,
        error: converted.error,
      })
      this.emit({ type: 'run_state', state: 'error', error: converted.error })
      return true
    }

    this.settlePending(pending, {
      behavior: 'allow',
      updatedInput: { ...pending.input, answers: converted.answers },
      toolUseID: pending.toolUseId,
      decisionClassification: 'user_temporary',
    })
    this.upsertTool(pending.toolUseId, {
      status: ToolCallResponseStatus.Running,
    })
    this.emitPendingRunStateOrRunning()
    return true
  }

  subscribe(listener: CliRuntimeEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.resetQuery()
    this.listeners.clear()
  }

  private assertUsable(): void {
    assertCliRuntimeAvailable('claude-code')
    if (this.disposed) {
      throw new Error('Claude CLI runtime has been disposed.')
    }
  }

  private assertClaudeRef(ref: CliSessionRef): void {
    if (ref.runtimeId !== 'claude-code') {
      throw new Error(`Claude adapter cannot open ${ref.runtimeId} sessions.`)
    }
  }

  private getSdk(): Promise<ClaudeSdkModule> {
    assertCliRuntimeAvailable('claude-code')
    this.sdkPromise ??= this.loadSdk()
    return this.sdkPromise
  }

  private createCanUseTool(): CanUseTool {
    return async (toolName, input, options) => {
      const kind =
        toolName === CLAUDE_ASK_USER_QUESTION_TOOL ? 'question' : 'approval'
      const normalizedInput =
        kind === 'question' ? normalizeAskUserQuestionInput(input) : input
      if (
        kind === 'question' &&
        mapClaudeAskUserQuestionInput(normalizedInput) === null
      ) {
        return {
          behavior: 'deny',
          message: 'Claude AskUserQuestion input is invalid.',
          interrupt: true,
          toolUseID: options.toolUseID,
        }
      }
      this.ensureToolRequest(options.toolUseID, toolName, normalizedInput)
      this.upsertTool(
        options.toolUseID,
        kind === 'question'
          ? { status: ToolCallResponseStatus.AwaitingUserInput }
          : { status: ToolCallResponseStatus.PendingApproval },
      )
      this.emit({
        type: 'run_state',
        state:
          kind === 'question' ? 'waiting_for_user' : 'waiting_for_approval',
      })

      return new Promise<PermissionResult>((resolve) => {
        const pending: PendingPermission = {
          requestId: options.requestId,
          toolUseId: options.toolUseID,
          toolName,
          input: normalizedInput,
          suggestions: options.suggestions,
          kind,
          resolve,
          settled: false,
        }
        this.pendingPermissions.set(options.requestId, pending)
        this.pendingPermissions.set(options.toolUseID, pending)

        const abort = (): void => {
          this.settlePending(pending, {
            behavior: 'deny',
            message: 'Claude permission request was aborted.',
            interrupt: true,
          })
        }
        if (options.signal.aborted) abort()
        else options.signal.addEventListener('abort', abort, { once: true })
      })
    }
  }

  private settlePending(
    pending: PendingPermission,
    result: PermissionResult,
  ): void {
    if (pending.settled) return
    pending.settled = true
    this.pendingPermissions.delete(pending.requestId)
    this.pendingPermissions.delete(pending.toolUseId)
    pending.resolve(result)
  }

  private settleAllPending(result: PermissionResult): void {
    for (const pending of new Set(this.pendingPermissions.values())) {
      this.settlePending(pending, result)
    }
  }

  private async consume(query: ClaudeSdkQuery): Promise<void> {
    try {
      for await (const message of query) {
        await this.handleSdkMessage(message)
      }
      if (!this.resetting && !this.disposed) {
        this.readyKey = undefined
        this.emit({
          type: 'run_state',
          state: 'error',
          error: 'Claude Code process exited unexpectedly.',
        })
      }
    } catch (error) {
      if (this.resetting || this.disposed) return
      this.readyKey = undefined
      this.emit({
        type: 'run_state',
        state: 'error',
        error: getErrorMessage(error),
      })
    }
  }

  private async handleSdkMessage(message: SDKMessage): Promise<void> {
    if (message.type === 'system' && message.subtype === 'status') {
      if (message.status === 'compacting') {
        this.emit({ type: 'compaction_state', isCompacting: true })
      } else if (message.compact_result !== undefined) {
        this.emit({ type: 'compaction_state', isCompacting: false })
      }
      return
    }
    if (message.type === 'system' && message.subtype === 'compact_boundary') {
      this.emit({ type: 'compaction_state', isCompacting: false })
      this.emit({
        type: 'compaction_boundary',
        boundary: {
          id: `claude-compact-${message.uuid}`,
          trigger: message.compact_metadata.trigger,
          preTokens: message.compact_metadata.pre_tokens,
          ...(message.compact_metadata.post_tokens !== undefined
            ? { postTokens: message.compact_metadata.post_tokens }
            : {}),
        },
      })
      return
    }
    if (message.type === 'system' && message.subtype === 'init') {
      this.reportedModelId = message.model
      this.publishSessionBound({
        runtimeId: 'claude-code',
        nativeSessionId: message.session_id,
      })
      return
    }
    if (message.type === 'stream_event') {
      this.handleStreamEvent(message)
      return
    }
    if (message.type === 'assistant') {
      if (message.parent_tool_use_id === null) {
        this.handleFinalAssistant(message)
      } else {
        this.handleNestedAssistant(message)
      }
      return
    }
    if (message.type === 'user') {
      if (isRecord(message.message)) {
        const results = extractToolResults(message.message.content)
        for (const result of results) {
          this.upsertTool(
            result.id,
            result.isError
              ? {
                  status: ToolCallResponseStatus.Error,
                  error: result.content,
                }
              : {
                  status: ToolCallResponseStatus.Success,
                  data: {
                    type: 'text',
                    text: result.content,
                    ...(message.tool_use_result !== undefined
                      ? {
                          metadata: {
                            cliToolResult: message.tool_use_result,
                          },
                        }
                      : {}),
                  },
                },
          )
        }
        if (results.length === 0) {
          const notification = parseClaudeTaskNotification(
            extractTextContent(message.message.content),
          )
          if (notification) {
            const failed =
              notification.status === 'failed' ||
              notification.status === 'errored'
            const previousResponse = this.tools.get(
              notification.toolUseId,
            )?.response
            const previousStructured =
              previousResponse?.status === ToolCallResponseStatus.Success &&
              isRecord(previousResponse.data.metadata?.cliToolResult)
                ? previousResponse.data.metadata.cliToolResult
                : null
            this.upsertTool(
              notification.toolUseId,
              failed
                ? {
                    status: ToolCallResponseStatus.Error,
                    error:
                      notification.result ||
                      notification.summary ||
                      notification.status,
                  }
                : {
                    status: ToolCallResponseStatus.Success,
                    data: {
                      type: 'text',
                      text: notification.result || notification.summary || '',
                      metadata: {
                        cliToolResult: {
                          ...(previousStructured ?? {}),
                          ...notification,
                        },
                      },
                    },
                  },
            )
          }
        }
      }
      return
    }
    if (message.type === 'result') {
      await this.handleResult(message)
    }
  }

  private handleStreamEvent(
    message: Extract<SDKMessage, { type: 'stream_event' }>,
  ): void {
    const event = message.event
    if (event.type === 'message_start') {
      if (message.parent_tool_use_id !== null) return
      this.ensureActiveAssistant(
        event.message.id,
        `claude-assistant-${event.message.id}`,
      )
      return
    }
    if (event.type === 'content_block_start') {
      if (
        message.parent_tool_use_id === null &&
        event.content_block.type === 'text' &&
        event.content_block.text
      ) {
        this.appendAssistantText(event.content_block.text)
      } else if (
        message.parent_tool_use_id === null &&
        event.content_block.type === 'thinking' &&
        event.content_block.thinking
      ) {
        this.appendAssistantReasoning(event.content_block.thinking)
      } else if (event.content_block.type === 'tool_use') {
        this.settleActiveReasoning()
        const toolUse = {
          id: event.content_block.id,
          name: event.content_block.name,
          rawInput: '',
          ...(message.parent_tool_use_id
            ? { parentCallId: message.parent_tool_use_id }
            : {}),
        }
        this.streamedToolInputs.set(event.index, toolUse)
        this.ensurePartialToolRequest(toolUse)
      }
      return
    }
    if (event.type !== 'content_block_delta') return

    if (
      message.parent_tool_use_id === null &&
      event.delta.type === 'text_delta'
    ) {
      this.appendAssistantText(event.delta.text)
    } else if (
      message.parent_tool_use_id === null &&
      event.delta.type === 'thinking_delta'
    ) {
      this.appendAssistantReasoning(event.delta.thinking)
    } else if (event.delta.type === 'input_json_delta') {
      const toolInput = this.streamedToolInputs.get(event.index)
      if (!toolInput) return
      toolInput.rawInput += event.delta.partial_json
      this.ensurePartialToolRequest(toolInput)
    }
  }

  private handleFinalAssistant(
    message: Extract<SDKMessage, { type: 'assistant' }>,
  ): void {
    const nativeMessage = message.message
    const assistant = this.ensureActiveAssistant(
      nativeMessage.id,
      `claude-assistant-${nativeMessage.id}`,
    )
    assistant.content = reconcileFinalText(
      assistant.content,
      extractTextContent(nativeMessage.content),
    )
    const finalReasoning = extractThinkingContent(nativeMessage.content)
    if (finalReasoning) {
      this.reasoningTracker?.observeReasoning()
      assistant.reasoning = reconcileFinalText(
        assistant.reasoning ?? '',
        finalReasoning,
      )
    }

    for (const toolUse of extractToolUses(nativeMessage.content)) {
      const request = toToolCallRequest(toolUse)
      this.setAssistantToolRequest(request)
      const existing = this.tools.get(toolUse.id)
      this.tools.set(toolUse.id, {
        request,
        response:
          existing?.response ??
          ({ status: ToolCallResponseStatus.Running } as ToolCallResponse),
      })
      this.emitTool(toolUse.id)
    }
    this.settleActiveReasoning()
    assistant.metadata = {
      ...assistant.metadata,
      generationState: 'completed',
    }
    this.emitAssistant()
  }

  private handleNestedAssistant(
    message: Extract<SDKMessage, { type: 'assistant' }>,
  ): void {
    const parentCallId = message.parent_tool_use_id
    if (!parentCallId) return
    const nativeMessage = message.message
    const requests = extractToolUses(nativeMessage.content).map((toolUse) =>
      toToolCallRequest({ ...toolUse, parentCallId }),
    )
    for (const request of requests) {
      this.emit({
        type: 'message_remove',
        messageId: `claude-nested-request-${request.id}`,
      })
    }
    this.emit({
      type: 'message_upsert',
      message: {
        role: 'assistant',
        id: message.uuid,
        content: extractTextContent(nativeMessage.content),
        ...(extractThinkingContent(nativeMessage.content)
          ? { reasoning: extractThinkingContent(nativeMessage.content) }
          : {}),
        ...(requests.length > 0 ? { toolCallRequests: requests } : {}),
        metadata: {
          generationState: 'completed',
          cliSubagentParentCallId: parentCallId,
        },
      },
    })
    for (const request of requests) {
      const existing = this.tools.get(request.id)
      this.tools.set(request.id, {
        request,
        response:
          existing?.response ??
          ({ status: ToolCallResponseStatus.Running } as ToolCallResponse),
      })
      this.emitTool(request.id)
    }
  }

  private async handleResult(
    message: Extract<SDKMessage, { type: 'result' }>,
  ): Promise<void> {
    await this.publishActiveTurnEditSummary()
    this.activeUserMessageId = undefined
    await this.emitContextUsageFromResult(message)
    const usage = mapClaudeResultResponseUsage(message)
    const durationMs =
      typeof message.duration_ms === 'number' &&
      Number.isFinite(message.duration_ms) &&
      message.duration_ms >= 0
        ? message.duration_ms
        : undefined
    if (usage || durationMs !== undefined) {
      this.emit({
        type: 'turn_metrics',
        ...(usage ? { usage } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      })
    }
    if (message.subtype === 'success') {
      if (message.result) {
        const assistant =
          this.activeAssistant ??
          this.ensureActiveAssistant(
            message.uuid,
            `claude-assistant-${message.uuid}`,
          )
        if (!assistant.content) assistant.content = message.result
      }
      if (this.cancelRequested) {
        this.markActiveAssistant('aborted')
        this.emit({ type: 'run_state', state: 'aborted' })
      } else {
        this.markActiveAssistant('completed')
        this.emit({ type: 'run_state', state: 'completed' })
      }
      this.cancelRequested = false
      return
    }

    const error = message.errors.filter(Boolean).join('\n') || message.subtype
    if (this.activeAssistant) {
      this.activeAssistant.metadata = {
        ...this.activeAssistant.metadata,
        generationState: 'error',
        errorMessage: error,
      }
      this.emitAssistant()
    }
    this.emit({ type: 'run_state', state: 'error', error })
  }

  private async emitContextUsageFromResult(
    message: Extract<SDKMessage, { type: 'result' }>,
  ): Promise<void> {
    const fromResult = mapClaudeResultContextUsage(message)
    let usage = fromResult
    const query = this.query
    if (query && typeof query.getContextUsage === 'function') {
      try {
        const detailed = mapClaudeGetContextUsage(await query.getContextUsage())
        if (detailed) {
          usage = {
            ...detailed,
            // Keep result-derived max if getContextUsage omitted it.
            maxContextTokens:
              detailed.maxContextTokens ?? fromResult?.maxContextTokens ?? null,
            ...(fromResult?.cacheHitRate !== undefined
              ? { cacheHitRate: fromResult.cacheHitRate }
              : {}),
          }
        }
      } catch (error) {
        console.warn('[YOLO] Claude getContextUsage failed', error)
      }
    }
    if (!usage) return
    this.emit({ type: 'context_usage', usage })
  }

  private async emitRestoredContextUsage(query: ClaudeSdkQuery): Promise<void> {
    try {
      const usage = mapClaudeGetContextUsage(await query.getContextUsage())
      if (!usage || this.query !== query) return
      this.emit({ type: 'context_usage', usage })
    } catch (error) {
      if (this.query === query) {
        console.warn('[YOLO] Claude restored context usage failed', error)
      }
    }
  }

  private async publishActiveTurnEditSummary(): Promise<void> {
    const sourceUserMessageId = this.activeUserMessageId
    const query = this.query
    if (!sourceUserMessageId || !query) return
    try {
      const result = await query.rewindFiles(sourceUserMessageId, {
        dryRun: true,
      })
      const files = [
        ...new Set(
          (result.filesChanged ?? []).map((path) =>
            toVaultRelativePath(this.vaultPath, path),
          ),
        ),
      ]
      if (!result.canRewind || files.length === 0) return
      const insertions = result.insertions ?? 0
      const deletions = result.deletions ?? 0
      const hasPerFileStats = files.length === 1
      this.emit({
        type: 'turn_edit_summary',
        sourceUserMessageId,
        summary: {
          files: files.map((path, index) => ({
            path,
            addedLines: index === 0 ? insertions : 0,
            removedLines: index === 0 ? deletions : 0,
            lineStatsAvailable: hasPerFileStats,
            operation: 'edit',
            undoStatus: 'unavailable',
          })),
          totalFiles: files.length,
          totalAddedLines: insertions,
          totalRemovedLines: deletions,
          undoStatus: 'unavailable',
        },
      })
    } catch (error) {
      console.warn(
        '[YOLO] Failed to read Claude file checkpoint summary',
        error,
      )
    }
  }

  private ensureActiveAssistant(key: string, id: string): ChatAssistantMessage {
    if (!this.activeAssistant || this.activeAssistantKey !== key) {
      if (this.activeAssistant) {
        this.settleActiveReasoning()
        this.activeAssistant.metadata = {
          ...this.activeAssistant.metadata,
          generationState: 'completed',
        }
        this.emitAssistant()
      }
      this.activeAssistantKey = key
      this.reasoningTracker = new ReasoningPhaseTracker()
      this.activeAssistant = {
        role: 'assistant',
        id,
        content: '',
        metadata: { generationState: 'streaming' },
      }
    }
    return this.activeAssistant
  }

  private appendAssistantText(text: string): void {
    if (!text) return
    const id = uuidv4()
    const assistant =
      this.activeAssistant ??
      this.ensureActiveAssistant(id, `claude-assistant-${id}`)
    this.settleActiveReasoning()
    assistant.content += text
    this.emitAssistant()
  }

  private appendAssistantReasoning(reasoning: string): void {
    if (!reasoning) return
    const id = uuidv4()
    const assistant =
      this.activeAssistant ??
      this.ensureActiveAssistant(id, `claude-assistant-${id}`)
    this.reasoningTracker?.observeReasoning()
    assistant.reasoning = (assistant.reasoning ?? '') + reasoning
    this.emitAssistant()
  }

  private ensurePartialToolRequest(tool: StreamedToolInput): void {
    if (tool.name === CLAUDE_ASK_USER_QUESTION_TOOL) return
    const request = createCliToolCallRequest({
      id: tool.id,
      arguments: createPartialToolCallArguments(tool.rawInput),
      metadata: {
        runtimeId: 'claude-code',
        eventType: 'tool_use',
        name: tool.name,
        ...(tool.parentCallId ? { parentCallId: tool.parentCallId } : {}),
        ...(tool.name === CLAUDE_BASH_TOOL
          ? { capability: 'command_execution' as const }
          : {}),
      },
    })
    if (tool.parentCallId) {
      this.emit({
        type: 'message_upsert',
        message: {
          role: 'assistant',
          id: `claude-nested-request-${tool.id}`,
          content: '',
          toolCallRequests: [request],
          metadata: { generationState: 'streaming' },
        },
      })
    } else {
      this.setAssistantToolRequest(request)
    }
    const existing = this.tools.get(tool.id)
    this.tools.set(tool.id, {
      request,
      response:
        existing?.response ??
        ({ status: ToolCallResponseStatus.Running } as ToolCallResponse),
    })
    this.emitAssistant()
    this.emitTool(tool.id)
  }

  private ensureToolRequest(
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): void {
    const request = toToolCallRequest({
      id: toolUseId,
      name: toolName,
      input,
    })
    this.setAssistantToolRequest(request)
    const existing = this.tools.get(toolUseId)
    this.tools.set(toolUseId, {
      request,
      response:
        existing?.response ??
        ({ status: ToolCallResponseStatus.Running } as ToolCallResponse),
    })
    this.emitAssistant()
  }

  private setAssistantToolRequest(request: ToolCallRequest): void {
    const id = uuidv4()
    const assistant =
      this.activeAssistant ??
      this.ensureActiveAssistant(id, `claude-assistant-${id}`)
    const requests = assistant.toolCallRequests ?? []
    const index = requests.findIndex((candidate) => candidate.id === request.id)
    if (index >= 0) requests[index] = request
    else requests.push(request)
    assistant.toolCallRequests = requests
  }

  private upsertTool(toolUseId: string, response: ToolCallResponse): void {
    const existing = this.tools.get(toolUseId)
    const request = existing?.request ?? {
      id: toolUseId,
      name: 'unknown',
    }
    this.tools.set(toolUseId, { request, response })
    this.emitTool(toolUseId)
  }

  private emitTool(toolUseId: string): void {
    const tool = this.tools.get(toolUseId)
    if (!tool) return
    this.emit({
      type: 'message_upsert',
      message: cloneToolMessage({
        role: 'tool',
        id: `claude-tool-${toolUseId}`,
        toolCalls: [tool],
      }),
    })
  }

  private emitAssistant(): void {
    if (!this.activeAssistant) return
    this.emit({
      type: 'message_upsert',
      message: cloneAssistantMessage(this.activeAssistant),
    })
  }

  private markActiveAssistant(generationState: 'completed' | 'aborted'): void {
    if (!this.activeAssistant) return
    this.settleActiveReasoning()
    this.activeAssistant.metadata = {
      ...this.activeAssistant.metadata,
      generationState,
    }
    this.emitAssistant()
  }

  private settleActiveReasoning(): number | undefined {
    const reasoningDurationMs = this.reasoningTracker?.settle()
    if (reasoningDurationMs !== undefined && this.activeAssistant) {
      this.activeAssistant.metadata = {
        ...this.activeAssistant.metadata,
        reasoningDurationMs,
      }
    }
    return reasoningDurationMs
  }

  private emit(event: CliRuntimeEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private publishSessionBound(ref: CliSessionRef): void {
    if (
      this.currentSessionRef &&
      this.currentSessionRef.nativeSessionId !== ref.nativeSessionId
    ) {
      return
    }
    this.currentSessionRef = ref
    if (this.publishedSessionRef?.nativeSessionId === ref.nativeSessionId) {
      return
    }
    this.publishedSessionRef = ref
    this.emit({ type: 'session_bound', ref })
  }

  private emitPendingRunStateOrRunning(): void {
    const pending = Array.from(new Set(this.pendingPermissions.values()))
    const state = pending.some((request) => request.kind === 'question')
      ? 'waiting_for_user'
      : pending.some((request) => request.kind === 'approval')
        ? 'waiting_for_approval'
        : 'running'
    this.emit({ type: 'run_state', state })
  }

  private async resetQuery(): Promise<void> {
    const query = this.query
    const consumePromise = this.consumePromise
    this.resetting = true
    this.settleAllPending({
      behavior: 'deny',
      message: 'Claude runtime was reset.',
      interrupt: true,
    })
    this.inputQueue?.close()
    query?.close()
    if (query?.return) {
      await query.return()
    }
    await consumePromise?.catch(() => undefined)

    this.query = undefined
    this.inputQueue = undefined
    this.consumePromise = undefined
    this.readyKey = undefined
    this.currentSessionRef = undefined
    this.publishedSessionRef = undefined
    this.models = []
    this.modelId = null
    this.reportedModelId = null
    this.reasoningEffort = null
    this.activeAssistant = undefined
    this.activeAssistantKey = undefined
    this.reasoningTracker = undefined
    this.activeUserMessageId = undefined
    this.tools.clear()
    this.streamedToolInputs.clear()
    this.resetting = false
  }
}
