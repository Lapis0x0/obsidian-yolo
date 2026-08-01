import type { ContentPart } from '../../../types/llm/request'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import type {
  CliApprovalResponse,
  CliQuestionResponse,
  CliRewriteTurnInput,
  CliRuntime,
  CliRuntimeConfiguration,
  CliRuntimeConfigurationUpdate,
  CliRuntimeEvent,
  CliRuntimeEventListener,
  CliRuntimeModel,
  CliRuntimeReadyInput,
  CliSessionHydration,
  CliSessionRef,
  CliTurnInput,
} from '../types'

import {
  CodexAppServerHost,
  type CodexAppServerHostOptions,
  type CodexHostResolver,
} from './host'
import {
  buildPendingToolMessages,
  mapCodexItem,
  mapCodexTurns,
} from './mapping'
import type { CodexProcessOptions } from './process'
import type {
  CodexServerRequest,
  CodexThread,
  CodexThreadItem,
  CodexUserInput,
  ModelListResponse,
  ThreadReadResponse,
  ThreadResumeResponse,
  ThreadRollbackResponse,
  ThreadStartResponse,
  TurnStartResponse,
} from './protocol'

type PendingServerRequest = {
  request: CodexServerRequest
  toolCallId: string
  kind: 'approval' | 'question'
}

export type CodexCliRuntimeOptions = CodexProcessOptions & {
  resolveHost?: CodexHostResolver
  createProcess?: CodexAppServerHostOptions['createProcess']
}

const toSessionRef = (thread: CodexThread): CliSessionRef => ({
  runtimeId: 'codex',
  nativeSessionId: thread.id,
  ...(thread.path ? { sessionPathHint: thread.path } : {}),
})

const toCodexInput = (content: string | ContentPart[]): CodexUserInput[] => {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content, text_elements: [] }]
  }
  return [
    ...content.flatMap((part): CodexUserInput[] => {
      if (part.type === 'text') {
        return [{ type: 'text', text: part.text, text_elements: [] }]
      }
      if (part.type === 'image_url') {
        return [{ type: 'image', url: part.image_url.url }]
      }
      throw new Error('Codex CLI runtime does not support PDF attachments.')
    }),
  ]
}

const approvalDecision = (
  decision: CliApprovalResponse['decision'],
): 'accept' | 'acceptForSession' | 'decline' => {
  if (decision === 'approve_once') return 'accept'
  if (decision === 'approve_for_session') return 'acceptForSession'
  return 'decline'
}

const permissionApprovalResult = (
  request: CodexServerRequest,
  decision: Exclude<CliApprovalResponse['decision'], 'reject'>,
): Record<string, unknown> => ({
  permissions:
    request.params.permissions &&
    typeof request.params.permissions === 'object' &&
    !Array.isArray(request.params.permissions)
      ? request.params.permissions
      : {},
  scope: decision === 'approve_for_session' ? 'session' : 'turn',
})

const toCodexQuestionAnswers = (answer: unknown): Record<string, unknown> => {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return {}
  const rawAnswers = (answer as { answers?: unknown }).answers
  if (!Array.isArray(rawAnswers)) return {}
  return Object.fromEntries(
    rawAnswers.flatMap((entry): Array<[string, { answers: string[] }]> => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
      const value = entry as {
        id?: unknown
        value?: unknown
        otherText?: unknown
      }
      if (typeof value.id !== 'string') return []
      const answers = Array.isArray(value.value)
        ? value.value.filter((item): item is string => typeof item === 'string')
        : typeof value.value === 'string'
          ? [value.value]
          : []
      if (typeof value.otherText === 'string' && value.otherText.trim()) {
        answers.push(value.otherText.trim())
      }
      return [[value.id, { answers }]]
    }),
  )
}

export class CodexCliRuntime implements CliRuntime {
  readonly runtimeId = 'codex' as const

  private host: CodexAppServerHost | null = null
  private ownsHost = false
  private detachHostListeners: (() => void) | null = null
  private readonly listeners = new Set<CliRuntimeEventListener>()
  private readonly pendingRequests = new Map<string, PendingServerRequest>()
  private activeSessionRef: CliSessionRef | null = null
  private activeTurnId: string | null = null
  private needsSessionRebind = false
  private models: CliRuntimeConfiguration['models'] | null = null
  private modelId: string | null = null
  private reasoningEffort: string | null = null
  private disposed = false

  constructor(private readonly options: CodexCliRuntimeOptions) {}

  async openSession(ref: CliSessionRef): Promise<CliSessionHydration> {
    if (ref.runtimeId !== 'codex')
      throw new Error('Cannot open a non-Codex session.')
    const host = await this.getHost()
    const response = await host.request<ThreadReadResponse>('thread/read', {
      threadId: ref.nativeSessionId,
      includeTurns: true,
    })
    return {
      ref: toSessionRef(response.thread),
      messages: mapCodexTurns(response.thread.turns, response.thread.cwd),
    }
  }

  async ensureReady(input: CliRuntimeReadyInput): Promise<void> {
    const previousHost = this.host
    const host = await this.getHost()
    if (
      this.activeSessionRef &&
      input.sessionRef?.nativeSessionId ===
        this.activeSessionRef.nativeSessionId &&
      !this.needsSessionRebind &&
      previousHost === host
    ) {
      return
    }

    const params = {
      cwd: this.options.cwd,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      experimentalRawEvents: true,
    }
    const response = input.sessionRef
      ? await host.request<ThreadResumeResponse>('thread/resume', {
          threadId: input.sessionRef.nativeSessionId,
          ...params,
        })
      : await host.request<ThreadStartResponse>('thread/start', params)
    this.activeSessionRef = toSessionRef(response.thread)
    this.modelId = response.model ?? null
    this.reasoningEffort = response.reasoningEffort ?? null
    this.needsSessionRebind = false
    this.emit({ type: 'session_bound', ref: this.activeSessionRef })
  }

  async getConfiguration(
    cachedModels?: readonly CliRuntimeModel[],
  ): Promise<CliRuntimeConfiguration> {
    if (!this.activeSessionRef) throw new Error('Codex runtime is not ready.')
    const models = cachedModels?.length
      ? cachedModels.map((model) => ({ ...model }))
      : await this.listModels()
    this.modelId ??=
      models.find((model) => model.isDefault)?.id ?? models[0]?.id ?? null
    return {
      models,
      modelId: this.modelId,
      reasoningEffort: this.reasoningEffort,
    }
  }

  async updateConfiguration(
    update: CliRuntimeConfigurationUpdate,
  ): Promise<CliRuntimeConfiguration> {
    if (!this.activeSessionRef) throw new Error('Codex runtime is not ready.')
    if ('modelId' in update) this.modelId = update.modelId ?? null
    if ('reasoningEffort' in update) {
      this.reasoningEffort = update.reasoningEffort ?? null
    }
    return this.getConfiguration()
  }

  async sendTurn(input: CliTurnInput): Promise<void> {
    if (input.sessionRef) {
      if (
        !this.activeSessionRef ||
        input.sessionRef.nativeSessionId !==
          this.activeSessionRef.nativeSessionId
      ) {
        throw new Error(
          'Codex session must be resumed with ensureReady before sending.',
        )
      }
    }
    if (!this.activeSessionRef) throw new Error('Codex runtime is not ready.')
    const host = await this.getHost()
    this.emit({ type: 'run_state', state: 'running' })
    const response = await host.request<TurnStartResponse>(
      'turn/start',
      {
        threadId: this.activeSessionRef.nativeSessionId,
        input: toCodexInput(input.content),
        model: this.modelId,
        effort: this.reasoningEffort,
        summary: 'auto',
      },
      0,
    )
    this.activeTurnId ??= response.turn.id
  }

  async rewriteTurn(input: CliRewriteTurnInput): Promise<void> {
    if (!this.activeSessionRef) throw new Error('Codex runtime is not ready.')
    if (this.activeTurnId) {
      throw new Error(
        'Cannot rewrite a Codex turn while another turn is active.',
      )
    }
    if (
      input.sessionRef &&
      input.sessionRef.nativeSessionId !== this.activeSessionRef.nativeSessionId
    ) {
      throw new Error('Codex rewrite does not match the active native session.')
    }

    const host = await this.getHost()
    const threadId = this.activeSessionRef.nativeSessionId
    const { thread } = await host.request<ThreadReadResponse>('thread/read', {
      threadId,
      includeTurns: true,
    })
    const nativeUserItemId = input.sourceUserMessageId.startsWith('codex-user-')
      ? input.sourceUserMessageId.slice('codex-user-'.length)
      : input.sourceUserMessageId
    const targetTurnIndex = thread.turns.findIndex((turn) =>
      turn.items.some(
        (item) => item.type === 'userMessage' && item.id === nativeUserItemId,
      ),
    )
    if (targetTurnIndex < 0) {
      throw new Error('The selected Codex user message no longer exists.')
    }

    const rollback = await host.request<ThreadRollbackResponse>(
      'thread/rollback',
      {
        threadId,
        numTurns: thread.turns.length - targetTurnIndex,
      },
    )
    if (rollback.thread.id !== threadId) {
      throw new Error('Codex rollback returned a different thread.')
    }
    this.activeSessionRef = toSessionRef(rollback.thread)
    this.pendingRequests.clear()
    this.streamingAssistantText.clear()
    this.streamingReasoningSummaryParts.clear()
    this.streamingReasoningContentParts.clear()

    await this.sendTurn({
      ...input,
      sessionRef: this.activeSessionRef,
    })
  }

  async cancel(): Promise<void> {
    if (!this.activeSessionRef || !this.activeTurnId) return
    await (
      await this.getHost()
    ).request('turn/interrupt', {
      threadId: this.activeSessionRef.nativeSessionId,
      turnId: this.activeTurnId,
    })
  }

  async respondApproval(response: CliApprovalResponse): Promise<boolean> {
    const pending = this.pendingRequests.get(response.requestId)
    if (!pending || pending.kind !== 'approval') return false
    this.deletePendingRequest(pending)
    const host = await this.getHost()
    if (pending.request.method === 'item/permissions/requestApproval') {
      if (response.decision === 'reject') {
        host.respondError(
          pending.request.id,
          -32000,
          'User denied the requested permissions.',
          null,
        )
      } else {
        host.respond(
          pending.request.id,
          permissionApprovalResult(pending.request, response.decision),
        )
      }
    } else {
      host.respond(pending.request.id, {
        decision: approvalDecision(response.decision),
      })
    }
    return true
  }

  async respondQuestion(response: CliQuestionResponse): Promise<boolean> {
    const pending = this.pendingRequests.get(response.requestId)
    if (!pending || pending.kind !== 'question') return false
    this.deletePendingRequest(pending)
    ;(await this.getHost()).respond(pending.request.id, {
      answers: toCodexQuestionAnswers(response.answer),
    })
    return true
  }

  subscribe(listener: CliRuntimeEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.detachHostListeners?.()
    this.detachHostListeners = null
    const host = this.host
    this.host = null
    if (host && this.ownsHost) await host.dispose()
    this.listeners.clear()
    this.pendingRequests.clear()
  }

  private emit(event: CliRuntimeEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private async getHost(): Promise<CodexAppServerHost> {
    if (this.disposed) throw new Error('Codex CLI runtime has been disposed.')
    const host = this.host
      ? this.host
      : this.options.resolveHost
        ? await this.options.resolveHost()
        : new CodexAppServerHost({
            command: this.options.command,
            cwd: this.options.cwd,
            env: this.options.env,
            createProcess: this.options.createProcess,
          })
    if (this.host !== host) {
      this.detachHostListeners?.()
      this.host = host
      this.ownsHost = !this.options.resolveHost
      const detachNotification = host.onNotification((notification) =>
        this.handleNotification(notification.method, notification.params),
      )
      const detachServerRequest = host.onServerRequest((request) =>
        this.handleServerRequest(request),
      )
      const detachFatal = host.onFatal((error) => this.handleHostFatal(error))
      this.detachHostListeners = () => {
        detachNotification()
        detachServerRequest()
        detachFatal()
      }
    }
    await host.ensureReady()
    return host
  }

  async listModels(): Promise<CliRuntimeConfiguration['models']> {
    if (this.models) return this.models
    const host = await this.getHost()
    const models: CliRuntimeConfiguration['models'] = []
    let cursor: string | null = null
    do {
      const response: ModelListResponse = await host.request<ModelListResponse>(
        'model/list',
        {
          cursor,
          limit: 100,
          includeHidden: false,
        },
      )
      models.push(
        ...response.data
          .filter((model) => !model.hidden)
          .map((model) => ({
            id: model.model || model.id,
            label: model.displayName,
            ...(model.description ? { description: model.description } : {}),
            reasoningEfforts: model.supportedReasoningEfforts.map((effort) => ({
              id: effort.reasoningEffort,
              ...(effort.description
                ? { description: effort.description }
                : {}),
            })),
            defaultReasoningEffort: model.defaultReasoningEffort,
            isDefault: model.isDefault,
          })),
      )
      cursor = response.nextCursor
    } while (cursor)
    this.models = models
    return models
  }

  private handleHostFatal(error: Error): void {
    this.activeTurnId = null
    this.needsSessionRebind = true
    this.models = null
    this.modelId = null
    this.reasoningEffort = null
    this.pendingRequests.clear()
    this.streamingAssistantText.clear()
    this.streamingReasoningSummaryParts.clear()
    this.streamingReasoningContentParts.clear()
    if (!this.disposed) {
      this.emit({ type: 'run_state', state: 'error', error: error.message })
    }
  }

  private handleNotification(
    method: string,
    params: Record<string, unknown>,
  ): void {
    const threadId = params.threadId
    if (
      this.activeSessionRef &&
      typeof threadId === 'string' &&
      threadId !== this.activeSessionRef.nativeSessionId
    ) {
      return
    }
    if (method === 'turn/started') {
      const turn = params.turn as { id?: unknown } | undefined
      this.activeTurnId = typeof turn?.id === 'string' ? turn.id : null
      return
    }
    if (method === 'item/agentMessage/delta') {
      const itemId =
        typeof params.itemId === 'string' ? params.itemId : 'stream'
      const delta = typeof params.delta === 'string' ? params.delta : ''
      const existing = this.streamingAssistantText.get(itemId) ?? ''
      const content = `${existing}${delta}`
      this.streamingAssistantText.set(itemId, content)
      this.emit({
        type: 'message_upsert',
        message: {
          role: 'assistant',
          id: `codex-assistant-${itemId}`,
          content,
          metadata: { generationState: 'streaming' },
        },
      })
      return
    }
    if (
      method === 'item/reasoning/summaryTextDelta' ||
      method === 'item/reasoning/textDelta'
    ) {
      const itemId =
        typeof params.itemId === 'string' ? params.itemId : 'reasoning'
      const delta = typeof params.delta === 'string' ? params.delta : ''
      const isSummary = method === 'item/reasoning/summaryTextDelta'
      const indexValue = isSummary ? params.summaryIndex : params.contentIndex
      const index = typeof indexValue === 'number' ? indexValue : 0
      const target = isSummary
        ? this.streamingReasoningSummaryParts
        : this.streamingReasoningContentParts
      const parts = target.get(itemId) ?? []
      parts[index] = `${parts[index] ?? ''}${delta}`
      target.set(itemId, parts)
      const reasoning = [
        ...(this.streamingReasoningSummaryParts.get(itemId) ?? []),
        ...(this.streamingReasoningContentParts.get(itemId) ?? []),
      ]
        .filter(Boolean)
        .join('\n\n')
      this.emit({
        type: 'message_upsert',
        message: {
          role: 'assistant',
          id: `codex-reasoning-${itemId}`,
          content: '',
          reasoning,
          metadata: { generationState: 'streaming' },
        },
      })
      return
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = params.item as CodexThreadItem | undefined
      if (!item) return
      for (const message of mapCodexItem(item, this.options.cwd)) {
        this.emit({ type: 'message_upsert', message })
      }
      return
    }
    if (method === 'serverRequest/resolved') {
      const requestId = params.requestId
      if (typeof requestId === 'string' || typeof requestId === 'number') {
        for (const [key, pending] of this.pendingRequests) {
          if (String(pending.request.id) === String(requestId)) {
            this.pendingRequests.delete(key)
          }
        }
      }
      return
    }
    if (method === 'turn/completed') {
      const turn = params.turn as
        | { status?: unknown; error?: { message?: unknown } }
        | undefined
      const status =
        typeof turn?.status === 'string' ? turn.status : 'completed'
      const isError = status === 'failed'
      this.emit({
        type: 'run_state',
        state:
          status === 'interrupted'
            ? 'aborted'
            : isError
              ? 'error'
              : 'completed',
        ...(isError && typeof turn?.error?.message === 'string'
          ? { error: turn.error.message }
          : {}),
      })
      this.activeTurnId = null
    }
  }

  private readonly streamingAssistantText = new Map<string, string>()
  private readonly streamingReasoningSummaryParts = new Map<string, string[]>()
  private readonly streamingReasoningContentParts = new Map<string, string[]>()

  private handleServerRequest(request: CodexServerRequest): void {
    const threadId = request.params.threadId
    if (
      this.activeSessionRef &&
      typeof threadId === 'string' &&
      threadId !== this.activeSessionRef.nativeSessionId
    ) {
      return
    }
    const key =
      typeof request.params.approvalId === 'string'
        ? request.params.approvalId
        : typeof request.params.itemId === 'string'
          ? request.params.itemId
          : String(request.id)
    const itemId =
      typeof request.params.itemId === 'string' ? request.params.itemId : key
    if (
      request.method === 'item/commandExecution/requestApproval' ||
      request.method === 'item/fileChange/requestApproval' ||
      request.method === 'item/permissions/requestApproval'
    ) {
      this.registerPendingRequest(key, {
        request,
        toolCallId: itemId,
        kind: 'approval',
      })
      const [assistant, tool] = buildPendingToolMessages({
        requestId: request.id,
        toolCallId: itemId,
        name:
          request.method === 'item/commandExecution/requestApproval'
            ? 'codex_command_execution'
            : request.method === 'item/fileChange/requestApproval'
              ? 'codex_file_change'
              : 'codex_permissions',
        argumentsValue: request.params,
        responseStatus: ToolCallResponseStatus.PendingApproval,
      })
      this.emit({ type: 'message_upsert', message: assistant })
      this.emit({ type: 'message_upsert', message: tool })
      this.emit({ type: 'run_state', state: 'waiting_for_approval' })
      return
    }
    if (request.method === 'item/tool/requestUserInput') {
      this.registerPendingRequest(key, {
        request,
        toolCallId: itemId,
        kind: 'question',
      })
      const rawQuestions = Array.isArray(request.params.questions)
        ? request.params.questions
        : []
      const questions = rawQuestions.map((raw, index) => {
        const question = raw as {
          id?: unknown
          question?: unknown
          options?: unknown
        }
        const options = Array.isArray(question.options)
          ? question.options.map((option, optionIndex) => {
              const value = option as { label?: unknown; description?: unknown }
              const label =
                typeof value.label === 'string'
                  ? value.label
                  : `Option ${optionIndex + 1}`
              return {
                id: label,
                label,
                ...(typeof value.description === 'string'
                  ? { description: value.description }
                  : {}),
              }
            })
          : undefined
        const selectableOptions =
          options && options.length >= 2 ? options : undefined
        return {
          id:
            typeof question.id === 'string'
              ? question.id
              : `question-${index + 1}`,
          prompt:
            typeof question.question === 'string'
              ? question.question
              : 'Codex requires input.',
          inputType: selectableOptions ? 'single_select' : 'free_text',
          ...(selectableOptions ? { options: selectableOptions } : {}),
        }
      })
      const [assistant, tool] = buildPendingToolMessages({
        requestId: request.id,
        toolCallId: itemId,
        name: 'yolo_local__ask_user_question',
        argumentsValue: { questions },
        responseStatus: ToolCallResponseStatus.AwaitingUserInput,
      })
      this.emit({ type: 'message_upsert', message: assistant })
      this.emit({ type: 'message_upsert', message: tool })
      this.emit({ type: 'run_state', state: 'waiting_for_user' })
      return
    }
    void this.getHost().then((host) =>
      host.respondError(
        request.id,
        -32601,
        `Unsupported Codex request: ${request.method}`,
      ),
    )
  }

  private registerPendingRequest(
    protocolKey: string,
    pending: PendingServerRequest,
  ): void {
    this.pendingRequests.set(protocolKey, pending)
    this.pendingRequests.set(pending.toolCallId, pending)
  }

  private deletePendingRequest(pending: PendingServerRequest): void {
    for (const [key, candidate] of this.pendingRequests) {
      if (candidate === pending) this.pendingRequests.delete(key)
    }
  }
}
