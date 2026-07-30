import type { ContentPart } from '../../../types/llm/request'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import type {
  CliApprovalResponse,
  CliQuestionResponse,
  CliRuntime,
  CliRuntimeEvent,
  CliRuntimeEventListener,
  CliRuntimeReadyInput,
  CliSessionHydration,
  CliSessionMetadata,
  CliSessionRef,
  CliTurnInput,
} from '../types'

import { buildPendingToolMessages, mapCodexItem, mapCodexTurns } from './mapping'
import type {
  CodexServerRequest,
  CodexThread,
  CodexThreadItem,
  CodexUserInput,
  ThreadListResponse,
  ThreadReadResponse,
  ThreadResumeResponse,
  ThreadStartResponse,
  TurnStartResponse,
} from './protocol'
import {
  CodexAppServerProcess,
  type CodexProcessLike,
  type CodexProcessOptions,
} from './process'
import { CodexRpcTransport, initializeCodexTransport } from './transport'

type PendingServerRequest = {
  request: CodexServerRequest
  toolCallId: string
}

export type CodexCliRuntimeOptions = CodexProcessOptions & {
  createProcess?: (options: CodexProcessOptions) => Promise<CodexProcessLike>
}

const toSessionRef = (thread: CodexThread): CliSessionRef => ({
  runtimeId: 'codex',
  nativeSessionId: thread.id,
  ...(thread.path ? { sessionPathHint: thread.path } : {}),
})

const toSessionMetadata = (thread: CodexThread): CliSessionMetadata => ({
  ref: toSessionRef(thread),
  title: thread.name?.trim() || thread.preview.trim() || 'Codex session',
  ...(thread.preview.trim() ? { preview: thread.preview.trim() } : {}),
  createdAt: thread.createdAt * 1000,
  updatedAt: thread.updatedAt * 1000,
  cwd: thread.cwd,
})

const toCodexInput = (content: string | ContentPart[]): CodexUserInput[] => {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content, text_elements: [] }]
  }
  return content.flatMap((part): CodexUserInput[] => {
    if (part.type === 'text') {
      return [{ type: 'text', text: part.text, text_elements: [] }]
    }
    if (part.type === 'image_url') {
      return [{ type: 'image', url: part.image_url.url }]
    }
    throw new Error('Codex CLI runtime does not support PDF attachments.')
  })
}

const approvalDecision = (
  decision: CliApprovalResponse['decision'],
): 'accept' | 'acceptForSession' | 'decline' => {
  if (decision === 'approve_once') return 'accept'
  if (decision === 'approve_for_session') return 'acceptForSession'
  return 'decline'
}

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

  private process: CodexProcessLike | null = null
  private transport: CodexRpcTransport | null = null
  private transportPromise: Promise<CodexRpcTransport> | null = null
  private readonly listeners = new Set<CliRuntimeEventListener>()
  private readonly pendingRequests = new Map<string, PendingServerRequest>()
  private activeSessionRef: CliSessionRef | null = null
  private activeTurnId: string | null = null
  private assistantKey = ''

  constructor(private readonly options: CodexCliRuntimeOptions) {}

  async listSessions(): Promise<CliSessionMetadata[]> {
    const transport = await this.getTransport()
    const sessions: CliSessionMetadata[] = []
    let cursor: string | null = null
    do {
      const response: ThreadListResponse = await transport.request<ThreadListResponse>('thread/list', {
        cursor,
        limit: 100,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        cwd: this.options.cwd,
      })
      sessions.push(...response.data.map(toSessionMetadata))
      cursor = response.nextCursor
    } while (cursor)
    return sessions
  }

  async openSession(ref: CliSessionRef): Promise<CliSessionHydration> {
    if (ref.runtimeId !== 'codex') throw new Error('Cannot open a non-Codex session.')
    const transport = await this.getTransport()
    const response = await transport.request<ThreadReadResponse>('thread/read', {
      threadId: ref.nativeSessionId,
      includeTurns: true,
    })
    return { ref: toSessionRef(response.thread), messages: mapCodexTurns(response.thread.turns) }
  }

  async ensureReady(input: CliRuntimeReadyInput): Promise<void> {
    const transport = await this.getTransport()
    const assistantKey = JSON.stringify(input.assistant)
    if (
      this.activeSessionRef &&
      input.sessionRef?.nativeSessionId === this.activeSessionRef.nativeSessionId &&
      assistantKey === this.assistantKey
    ) {
      return
    }

    const params = {
      cwd: this.options.cwd,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      developerInstructions: input.assistant.systemPrompt || null,
      experimentalRawEvents: true,
    }
    const response = input.sessionRef
      ? await transport.request<ThreadResumeResponse>('thread/resume', {
          threadId: input.sessionRef.nativeSessionId,
          ...params,
        })
      : await transport.request<ThreadStartResponse>('thread/start', params)
    this.activeSessionRef = toSessionRef(response.thread)
    this.assistantKey = assistantKey
    this.emit({ type: 'session_bound', ref: this.activeSessionRef })
  }

  async sendTurn(input: CliTurnInput): Promise<void> {
    if (input.sessionRef) {
      if (
        !this.activeSessionRef ||
        input.sessionRef.nativeSessionId !== this.activeSessionRef.nativeSessionId
      ) {
        throw new Error('Codex session must be resumed with ensureReady before sending.')
      }
    }
    if (!this.activeSessionRef) throw new Error('Codex runtime is not ready.')
    this.emit({ type: 'run_state', state: 'running' })
    const response = await (await this.getTransport()).request<TurnStartResponse>(
      'turn/start',
      {
        threadId: this.activeSessionRef.nativeSessionId,
        input: toCodexInput(input.content),
      },
      0,
    )
    this.activeTurnId ??= response.turn.id
  }

  async cancel(): Promise<void> {
    if (!this.activeSessionRef || !this.activeTurnId) return
    await (await this.getTransport()).request('turn/interrupt', {
      threadId: this.activeSessionRef.nativeSessionId,
      turnId: this.activeTurnId,
    })
  }

  async respondApproval(response: CliApprovalResponse): Promise<void> {
    const pending = this.pendingRequests.get(response.requestId)
    if (!pending) throw new Error('Codex approval request is no longer pending.')
    this.pendingRequests.delete(response.requestId)
    ;(await this.getTransport()).respond(pending.request.id, {
      decision: approvalDecision(response.decision),
    })
  }

  async respondQuestion(response: CliQuestionResponse): Promise<void> {
    const pending = this.pendingRequests.get(response.requestId)
    if (!pending) throw new Error('Codex question is no longer pending.')
    this.pendingRequests.delete(response.requestId)
    ;(await this.getTransport()).respond(pending.request.id, {
      answers: toCodexQuestionAnswers(response.answer),
    })
  }

  subscribe(listener: CliRuntimeEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async dispose(): Promise<void> {
    if (this.transportPromise) {
      await this.transportPromise.catch(() => undefined)
    }
    this.transport?.dispose()
    this.transport = null
    if (this.process) await this.process.shutdown()
    this.process = null
    this.listeners.clear()
    this.pendingRequests.clear()
  }

  private emit(event: CliRuntimeEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private async getTransport(): Promise<CodexRpcTransport> {
    if (this.transport) return this.transport
    if (this.transportPromise) return this.transportPromise
    const promise = this.createTransport()
    this.transportPromise = promise
    try {
      return await promise
    } finally {
      if (this.transportPromise === promise) this.transportPromise = null
    }
  }

  private async createTransport(): Promise<CodexRpcTransport> {
    const createProcess = this.options.createProcess ?? CodexAppServerProcess.start
    this.process = await createProcess(this.options)
    const transport = new CodexRpcTransport(this.process)
    transport.onNotification((notification) =>
      this.handleNotification(notification.method, notification.params),
    )
    transport.onServerRequest((request) => this.handleServerRequest(request))
    try {
      await initializeCodexTransport(transport)
      this.transport = transport
      return transport
    } catch (error) {
      transport.dispose()
      await this.process.shutdown()
      this.process = null
      throw error
    }
  }

  private handleNotification(
    method: string,
    params: Record<string, unknown>,
  ): void {
    if (method === 'turn/started') {
      const turn = params.turn as { id?: unknown } | undefined
      this.activeTurnId = typeof turn?.id === 'string' ? turn.id : null
      return
    }
    if (method === 'item/agentMessage/delta') {
      const itemId = typeof params.itemId === 'string' ? params.itemId : 'stream'
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
    if (method === 'item/reasoning/summaryTextDelta') {
      const itemId = typeof params.itemId === 'string' ? params.itemId : 'reasoning'
      const delta = typeof params.delta === 'string' ? params.delta : ''
      const reasoning = `${this.streamingReasoningText.get(itemId) ?? ''}${delta}`
      this.streamingReasoningText.set(itemId, reasoning)
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
      for (const message of mapCodexItem(item)) {
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
      const turn = params.turn as { status?: unknown; error?: { message?: unknown } } | undefined
      const status = typeof turn?.status === 'string' ? turn.status : 'completed'
      const isError = status === 'failed'
      this.emit({
        type: 'run_state',
        state: status === 'interrupted' ? 'aborted' : isError ? 'error' : 'completed',
        ...(isError && typeof turn?.error?.message === 'string'
          ? { error: turn.error.message }
          : {}),
      })
      this.activeTurnId = null
    }
  }

  private readonly streamingAssistantText = new Map<string, string>()
  private readonly streamingReasoningText = new Map<string, string>()

  private handleServerRequest(request: CodexServerRequest): void {
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
      this.pendingRequests.set(key, { request, toolCallId: itemId })
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
      this.pendingRequests.set(key, { request, toolCallId: itemId })
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
                typeof value.label === 'string' ? value.label : `Option ${optionIndex + 1}`
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
          id: typeof question.id === 'string' ? question.id : `question-${index + 1}`,
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
        name: 'ask_user_question',
        argumentsValue: { questions },
        responseStatus: ToolCallResponseStatus.AwaitingUserInput,
      })
      this.emit({ type: 'message_upsert', message: assistant })
      this.emit({ type: 'message_upsert', message: tool })
      this.emit({ type: 'run_state', state: 'waiting_for_user' })
      return
    }
    void this.getTransport().then((transport) =>
      transport.respondError(request.id, -32601, `Unsupported Codex request: ${request.method}`),
    )
  }
}
