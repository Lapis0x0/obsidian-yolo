import type {
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
  SDKMessage,
  SDKUserMessage,
} from '@yolo/claude-agent-sdk-runtime'
import { v4 as uuidv4 } from 'uuid'

import type { ChatAssistantMessage, ChatToolMessage } from '../../../types/chat'
import type { ContentPart } from '../../../types/llm/request'
import {
  type ToolCallRequest,
  type ToolCallResponse,
  ToolCallResponseStatus,
  createPartialToolCallArguments,
} from '../../../types/tool-call.types'
import { assertCliRuntimeAvailable } from '../desktop'
import { isSessionPathInVault } from '../session-path'
import type {
  CliApprovalResponse,
  CliQuestionResponse,
  CliRuntime,
  CliRuntimeConfiguration,
  CliRuntimeConfigurationUpdate,
  CliRuntimeEvent,
  CliRuntimeEventListener,
  CliRuntimeReadyInput,
  CliSessionHydration,
  CliSessionMetadata,
  CliSessionRef,
  CliTurnInput,
} from '../types'

import {
  CLAUDE_ASK_USER_QUESTION_TOOL,
  convertYoloAnswerPayloadToClaude,
  mapClaudeAskUserQuestionInput,
} from './askUserQuestion'
import { AsyncPushQueue } from './asyncQueue'
import {
  extractTextContent,
  extractThinkingContent,
  extractToolResults,
  extractToolUses,
  hydrateClaudeSessionMessages,
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
}

export type ClaudeCliRuntimeOptions = {
  vaultPath: string
  configuredCliPath?: string
  loadSdk?: ClaudeSdkLoader
  resolveProcessSupport?: ClaudeProcessSupportResolver
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const CLAUDE_SESSION_PAGE_SIZE = 100

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

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
    uuid: uuidv4(),
    ...(sessionId ? { session_id: sessionId } : {}),
  }) as SDKUserMessage

export class ClaudeCliRuntime implements CliRuntime {
  readonly runtimeId = 'claude-code' as const

  private readonly vaultPath: string
  private readonly configuredCliPath?: string
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
  private reasoningEffort: string | null = null
  private activeAssistant?: ChatAssistantMessage
  private activeAssistantKey?: string
  private disposed = false
  private resetting = false
  private cancelRequested = false

  constructor(options: ClaudeCliRuntimeOptions) {
    this.vaultPath = options.vaultPath
    this.configuredCliPath = options.configuredCliPath
    this.loadSdk = options.loadSdk ?? loadClaudeAgentSdk
    this.resolveProcessSupport =
      options.resolveProcessSupport ??
      (() =>
        resolveClaudeProcessSupport({
          configuredCliPath: this.configuredCliPath,
        }))
  }

  async listSessions(): Promise<CliSessionMetadata[]> {
    this.assertUsable()
    const sdk = await this.getSdk()
    const sessions: Awaited<ReturnType<ClaudeSdkModule['listSessions']>> = []
    let offset = 0
    while (true) {
      const page = await sdk.listSessions({
        limit: CLAUDE_SESSION_PAGE_SIZE,
        offset,
      })
      sessions.push(...page)
      if (page.length < CLAUDE_SESSION_PAGE_SIZE) break
      offset += page.length
    }
    const belongsToVault = await Promise.all(
      sessions.map((session) =>
        session.cwd
          ? isSessionPathInVault(this.vaultPath, session.cwd)
          : Promise.resolve(false),
      ),
    )
    return sessions
      .filter((_, index) => belongsToVault[index])
      .map((session) => ({
        ref: {
          runtimeId: 'claude-code',
          nativeSessionId: session.sessionId,
        },
        title:
          session.customTitle ||
          session.summary ||
          session.firstPrompt ||
          session.sessionId,
        ...(session.firstPrompt && session.firstPrompt !== session.summary
          ? { preview: session.firstPrompt }
          : {}),
        ...(session.createdAt !== undefined
          ? { createdAt: session.createdAt }
          : {}),
        updatedAt: session.lastModified,
        ...(session.cwd ? { cwd: session.cwd } : {}),
      }))
  }

  async openSession(ref: CliSessionRef): Promise<CliSessionHydration> {
    this.assertUsable()
    this.assertClaudeRef(ref)
    const sdk = await this.getSdk()
    const messages = await sdk.getSessionMessages(ref.nativeSessionId)
    return { ref, messages: hydrateClaudeSessionMessages(messages) }
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

    await this.resetQuery()
    const sessionRef = input.sessionRef ?? {
      runtimeId: 'claude-code' as const,
      nativeSessionId: uuidv4(),
    }
    this.currentSessionRef = sessionRef
    this.publishedSessionRef = undefined
    this.readyKey = JSON.stringify({
      ...readyConfiguration,
      sessionId: sessionRef.nativeSessionId,
    })
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
      this.query = sdk.query({
        prompt: this.inputQueue,
        options: {
          abortController: nativeAbortController,
          cwd: this.vaultPath,
          pathToClaudeCodeExecutable: processSupport.cliPath,
          env: processSupport.env,
          spawnClaudeCodeProcess: processSupport.spawnClaudeCodeProcess,
          includePartialMessages: true,
          permissionMode: 'default',
          canUseTool: this.createCanUseTool(),
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
          },
          ...(input.sessionRef
            ? { resume: input.sessionRef.nativeSessionId }
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
      this.models = supportedModels.map((model) => ({
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
      }))
      this.modelId =
        this.models.find((model) => model.isDefault)?.id ??
        this.models[0]?.id ??
        null
      this.reasoningEffort = null
      this.publishSessionBound(sessionRef)
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
    this.streamedToolInputs.clear()
    this.cancelRequested = false
    this.emit({ type: 'run_state', state: 'running' })
    this.inputQueue.push(
      toSdkUserMessage(input.content, this.currentSessionRef?.nativeSessionId),
    )
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
        this.handleSdkMessage(message)
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

  private handleSdkMessage(message: SDKMessage): void {
    if (message.type === 'system' && message.subtype === 'init') {
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
    if (message.type === 'assistant' && message.parent_tool_use_id === null) {
      this.handleFinalAssistant(message)
      return
    }
    if (message.type === 'user' && message.parent_tool_use_id === null) {
      if (isRecord(message.message)) {
        for (const result of extractToolResults(message.message.content)) {
          this.upsertTool(
            result.id,
            result.isError
              ? {
                  status: ToolCallResponseStatus.Error,
                  error: result.content,
                }
              : {
                  status: ToolCallResponseStatus.Success,
                  data: { type: 'text', text: result.content },
                },
          )
        }
      }
      return
    }
    if (message.type === 'result') {
      this.handleResult(message)
    }
  }

  private handleStreamEvent(
    message: Extract<SDKMessage, { type: 'stream_event' }>,
  ): void {
    if (message.parent_tool_use_id !== null) return
    const event = message.event
    if (event.type === 'message_start') {
      this.ensureActiveAssistant(
        event.message.id,
        `claude-assistant-${event.message.id}`,
      )
      return
    }
    if (event.type === 'content_block_start') {
      if (event.content_block.type === 'text' && event.content_block.text) {
        this.appendAssistantText(event.content_block.text)
      } else if (
        event.content_block.type === 'thinking' &&
        event.content_block.thinking
      ) {
        this.appendAssistantReasoning(event.content_block.thinking)
      } else if (event.content_block.type === 'tool_use') {
        const toolUse = {
          id: event.content_block.id,
          name: event.content_block.name,
          rawInput: '',
        }
        this.streamedToolInputs.set(event.index, toolUse)
        this.ensurePartialToolRequest(toolUse)
      }
      return
    }
    if (event.type !== 'content_block_delta') return

    if (event.delta.type === 'text_delta') {
      this.appendAssistantText(event.delta.text)
    } else if (event.delta.type === 'thinking_delta') {
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
    assistant.metadata = {
      ...assistant.metadata,
      generationState: 'completed',
    }
    this.emitAssistant()
  }

  private handleResult(message: Extract<SDKMessage, { type: 'result' }>): void {
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

  private ensureActiveAssistant(key: string, id: string): ChatAssistantMessage {
    if (!this.activeAssistant || this.activeAssistantKey !== key) {
      if (this.activeAssistant) {
        this.activeAssistant.metadata = {
          ...this.activeAssistant.metadata,
          generationState: 'completed',
        }
        this.emitAssistant()
      }
      this.activeAssistantKey = key
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
    assistant.content += text
    this.emitAssistant()
  }

  private appendAssistantReasoning(reasoning: string): void {
    if (!reasoning) return
    const id = uuidv4()
    const assistant =
      this.activeAssistant ??
      this.ensureActiveAssistant(id, `claude-assistant-${id}`)
    assistant.reasoning = (assistant.reasoning ?? '') + reasoning
    this.emitAssistant()
  }

  private ensurePartialToolRequest(tool: StreamedToolInput): void {
    if (tool.name === CLAUDE_ASK_USER_QUESTION_TOOL) return
    const request: ToolCallRequest = {
      id: tool.id,
      name: tool.name,
      arguments: createPartialToolCallArguments(tool.rawInput),
    }
    this.setAssistantToolRequest(request)
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
    this.activeAssistant.metadata = {
      ...this.activeAssistant.metadata,
      generationState,
    }
    this.emitAssistant()
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
    this.reasoningEffort = null
    this.activeAssistant = undefined
    this.activeAssistantKey = undefined
    this.tools.clear()
    this.streamedToolInputs.clear()
    this.resetting = false
  }
}
