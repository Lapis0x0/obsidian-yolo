import type { ChatMessage } from '../../../types/chat'
import type { ContentPart } from '../../../types/llm/request'
import {
  type ToolCallRequest,
  ToolCallResponseStatus,
} from '../../../types/tool-call.types'
import { ReasoningPhaseTracker } from '../../../utils/chat/reasoningPhaseTracker'
import {
  mapCodexTokenUsageUpdated,
  mapCodexTurnResponseUsage,
} from '../context-usage'
import { includeActiveCliModel } from '../model-catalog'
import {
  type CliChatMode,
  type CodexSandboxMode,
  resolveCodexSandboxConfig,
} from '../permission-profile'
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
  CliRuntimeModel,
  CliRuntimeReadyInput,
  CliRuntimeSkill,
  CliSessionHydration,
  CliSessionRef,
  CliSubagentRef,
  CliSubagentTranscriptListener,
  CliTurnInput,
} from '../types'

import type { CodexSessionTranscript } from './history'
import {
  CodexAppServerHost,
  type CodexAppServerHostOptions,
  type CodexHostResolver,
} from './host'
import {
  buildPendingToolMessages,
  mapCodexItem,
  mapCodexRawToolCall,
  mapCodexRawToolOutput,
  mapCodexTranscript,
  mapCodexTurns,
  parseCodexUserMessageId,
  shouldEmitCodexItemOnStarted,
  toCodexClientUserMessageId,
} from './mapping'
import type { CodexProcessOptions } from './process'
import {
  type CodexMcpServerStatusEntry,
  CodexMcpServerStatusUnsupportedError,
  type CodexRawResponseItem,
  type CodexSandboxPolicy,
  type CodexServerRequest,
  type CodexThread,
  type CodexThreadItem,
  type CodexUserInput,
  type ConfigReadResponse,
  type McpServerStatusListResponse,
  type ModelListResponse,
  type SkillsListResponse,
  type ThreadCompactStartResponse,
  type ThreadReadResponse,
  type ThreadResumeResponse,
  type ThreadRollbackResponse,
  type ThreadStartResponse,
  type TurnStartResponse,
  isCodexMcpServerStatusUnsupportedError,
} from './protocol'

type PendingServerRequest = {
  request: CodexServerRequest
  toolCallId: string
  kind: 'approval' | 'question'
}

type CodexSubagentWatch = {
  messages: ChatMessage[]
  listeners: Set<CliSubagentTranscriptListener>
  assistantText: Map<string, string>
  reasoningSummaryParts: Map<string, string[]>
  reasoningContentParts: Map<string, string[]>
}

const upsertProjectedMessage = (
  messages: ChatMessage[],
  message: ChatMessage,
): void => {
  const index = messages.findIndex((candidate) => candidate.id === message.id)
  if (index < 0) messages.push(message)
  else messages[index] = message
}

export type CodexCliRuntimeOptions = CodexProcessOptions & {
  resolveHost?: CodexHostResolver
  createProcess?: CodexAppServerHostOptions['createProcess']
  loadSessionTranscript?: (
    sessionPath: string,
  ) => Promise<CodexSessionTranscript | null>
  /** Product chat mode mapped into Codex approval/sandbox at start/resume/turn. */
  cliChatMode?: CliChatMode
  /** When true with agent mode, maps to never + danger-full-access. */
  yoloEnabled?: boolean
  mapRuntimePathToHost?: (runtimePath: string) => string
}

const toCodexTurnSandboxPolicy = (
  sandbox: CodexSandboxMode,
  cwd: string,
): CodexSandboxPolicy => {
  if (sandbox === 'danger-full-access') {
    return { type: 'dangerFullAccess' }
  }
  if (sandbox === 'read-only') {
    return {
      type: 'readOnly',
      access: { type: 'fullAccess' },
      networkAccess: false,
    }
  }
  return {
    type: 'workspaceWrite',
    writableRoots: [cwd],
    readOnlyAccess: { type: 'fullAccess' },
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  }
}

/**
 * Codex's `mcpServerStatus/list` has no Claude-style top-level status field,
 * so the status is approximated from `serverInfo`/`authStatus`: a populated
 * `serverInfo` means the server finished initializing; `notLoggedIn` means it
 * is waiting on auth; an empty `serverInfo` with no auth blocker (undefined,
 * or an already-authenticated status) means it is still connecting; anything
 * else (e.g. `serverInfo` empty with `authStatus: 'unsupported'`) cannot be
 * classified confidently and falls back to `'unknown'`.
 */
const mapCodexMcpServerStatus = (
  entry: CodexMcpServerStatusEntry,
): CliRuntimeMcpServerStatus['status'] => {
  if (entry.serverInfo) return 'connected'
  if (entry.authStatus === 'notLoggedIn') return 'needs-auth'
  if (
    entry.authStatus === undefined ||
    entry.authStatus === 'bearerToken' ||
    entry.authStatus === 'oAuth'
  ) {
    return 'pending'
  }
  return 'unknown'
}

const toSessionRef = (
  thread: CodexThread,
  mapRuntimePathToHost?: (runtimePath: string) => string,
): CliSessionRef => ({
  runtimeId: 'codex',
  nativeSessionId: thread.id,
  ...(thread.path
    ? { sessionPathHint: mapRuntimePathToHost?.(thread.path) ?? thread.path }
    : {}),
})

const toCodexInput = (
  content: string | ContentPart[],
  selectedSkills: readonly CliRuntimeSkill[] = [],
): CodexUserInput[] => {
  const skillInputs: CodexUserInput[] = selectedSkills.map((skill) => ({
    type: 'skill',
    name: skill.name,
    path: skill.path,
  }))
  if (typeof content === 'string') {
    return [
      ...skillInputs,
      ...(content
        ? [
            {
              type: 'text' as const,
              text: content,
              text_elements: [] as [],
            },
          ]
        : []),
    ]
  }
  return [
    ...skillInputs,
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
  private readonly rawCustomToolRequests = new Map<string, ToolCallRequest[]>()
  private readonly subagentWatches = new Map<string, CodexSubagentWatch>()
  private activeSessionRef: CliSessionRef | null = null
  private activeTurnId: string | null = null
  private activeTurnStartedAt: number | null = null
  private needsSessionRebind = false
  private models: CliRuntimeConfiguration['models'] | null = null
  private modelId: string | null = null
  private reasoningEffort: string | null = null
  private cliChatMode: CliChatMode
  private yoloEnabled: boolean
  private disposed = false

  constructor(private readonly options: CodexCliRuntimeOptions) {
    this.cliChatMode = options.cliChatMode ?? 'agent'
    this.yoloEnabled = options.yoloEnabled ?? false
  }

  private resolveSandboxConfig() {
    return resolveCodexSandboxConfig(this.cliChatMode, this.yoloEnabled)
  }

  private threadPermissionParams() {
    const { approvalPolicy, sandbox } = this.resolveSandboxConfig()
    return { approvalPolicy, sandbox }
  }

  private turnPermissionParams() {
    const { approvalPolicy, sandbox } = this.resolveSandboxConfig()
    return {
      approvalPolicy,
      sandboxPolicy: toCodexTurnSandboxPolicy(sandbox, this.options.cwd),
    }
  }

  async openSession(ref: CliSessionRef): Promise<CliSessionHydration> {
    if (ref.runtimeId !== 'codex')
      throw new Error('Cannot open a non-Codex session.')
    const host = await this.getHost()
    const response = await host.request<ThreadReadResponse>('thread/read', {
      threadId: ref.nativeSessionId,
      includeTurns: true,
    })
    const sessionRef = toSessionRef(
      response.thread,
      this.options.mapRuntimePathToHost,
    )
    const sessionPath = sessionRef.sessionPathHint ?? ref.sessionPathHint
    const transcript = sessionPath
      ? await (
          this.options.loadSessionTranscript ??
          (async (path: string) =>
            (await import('./history')).loadCodexSessionTranscript(path))
        )(sessionPath)
      : null
    const fallbackTranscript = mapCodexTranscript(
      response.thread.turns,
      response.thread.cwd,
    )
    return {
      ref: sessionRef,
      ...(transcript ?? fallbackTranscript),
    }
  }

  async setSessionTitle(ref: CliSessionRef, title: string): Promise<void> {
    if (ref.runtimeId !== 'codex') {
      throw new Error('Cannot rename a non-Codex session.')
    }
    await (
      await this.getHost()
    ).request('thread/name/set', {
      threadId: ref.nativeSessionId,
      name: title,
    })
  }

  async readSubagent(ref: CliSubagentRef): Promise<readonly ChatMessage[]> {
    if (ref.parentSessionRef.runtimeId !== 'codex') {
      throw new Error('Cannot read a non-Codex subagent.')
    }
    const host = await this.getHost()
    const response = await host.request<ThreadReadResponse>('thread/read', {
      threadId: ref.subagentId,
      includeTurns: true,
    })
    return mapCodexTurns(response.thread.turns, response.thread.cwd)
  }

  async watchSubagent(
    ref: CliSubagentRef,
    listener: CliSubagentTranscriptListener,
  ): Promise<() => void> {
    let watch = this.subagentWatches.get(ref.subagentId)
    if (!watch) {
      watch = {
        messages: [...(await this.readSubagent(ref))],
        listeners: new Set(),
        assistantText: new Map(),
        reasoningSummaryParts: new Map(),
        reasoningContentParts: new Map(),
      }
      this.subagentWatches.set(ref.subagentId, watch)
    }
    watch.listeners.add(listener)
    listener(watch.messages)
    return () => {
      const current = this.subagentWatches.get(ref.subagentId)
      if (!current) return
      current.listeners.delete(listener)
      if (current.listeners.size === 0) {
        this.subagentWatches.delete(ref.subagentId)
      }
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
      ...this.threadPermissionParams(),
      experimentalRawEvents: true,
    }
    const response = input.sessionRef
      ? await host.request<ThreadResumeResponse>('thread/resume', {
          threadId: input.sessionRef.nativeSessionId,
          ...params,
        })
      : await host.request<ThreadStartResponse>('thread/start', params)
    this.activeSessionRef = toSessionRef(
      response.thread,
      this.options.mapRuntimePathToHost,
    )
    this.modelId = response.model ?? null
    this.reasoningEffort = response.reasoningEffort ?? null
    this.needsSessionRebind = false
    this.emit({ type: 'session_bound', ref: this.activeSessionRef })
  }

  async getConfiguration(
    cachedModels?: readonly CliRuntimeModel[],
  ): Promise<CliRuntimeConfiguration> {
    if (!this.activeSessionRef) throw new Error('Codex runtime is not ready.')
    const models = includeActiveCliModel(
      cachedModels?.length ? cachedModels : await this.listModels(),
      this.modelId,
    )
    this.modelId ??=
      models.find((model) => model.isDefault)?.id ?? models[0]?.id ?? null
    return {
      models,
      modelId: this.modelId,
      reasoningEffort: this.reasoningEffort,
    }
  }

  async listSkills(): Promise<CliRuntimeSkill[]> {
    const host = await this.getHost()
    const response = await host.request<SkillsListResponse>('skills/list', {
      cwds: [this.options.cwd],
      forceReload: true,
    })
    return response.data.flatMap((entry) =>
      entry.skills
        .filter((skill) => skill.enabled)
        .map(({ name, description, path }) => ({ name, description, path })),
    )
  }

  /**
   * Read-only snapshot of configured MCP server status. Codex has no
   * per-server toggle/reconnect RPC, so this is a display-only surface.
   * Throws `CodexMcpServerStatusUnsupportedError` when the connected Codex
   * CLI predates `mcpServerStatus/list`.
   */
  async mcpServerStatus(): Promise<CliRuntimeMcpServerStatus[]> {
    const host = await this.getHost()
    let response: McpServerStatusListResponse
    try {
      response = await host.request<McpServerStatusListResponse>(
        'mcpServerStatus/list',
        { detail: 'toolsAndAuthOnly' },
      )
    } catch (error) {
      if (isCodexMcpServerStatusUnsupportedError(error)) {
        throw new CodexMcpServerStatusUnsupportedError()
      }
      throw error
    }
    return response.data.map((entry) => ({
      name: entry.name,
      status: mapCodexMcpServerStatus(entry),
      toolCount: Object.keys(entry.tools ?? {}).length,
      readOnly: true,
    }))
  }

  async compact(): Promise<void> {
    if (!this.activeSessionRef) throw new Error('Codex runtime is not ready.')
    if (this.activeTurnId) {
      throw new Error('Cannot compact Codex while another turn is active.')
    }
    const host = await this.getHost()
    await host.request<ThreadCompactStartResponse>(
      'thread/compact/start',
      { threadId: this.activeSessionRef.nativeSessionId },
      0,
    )
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

  async updatePermissionProfile(
    update: CliPermissionProfileUpdate,
  ): Promise<void> {
    if (this.disposed) throw new Error('Codex CLI runtime has been disposed.')
    this.cliChatMode = update.mode
    this.yoloEnabled = update.yoloEnabled
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
        ...(input.userMessageId
          ? {
              clientUserMessageId: toCodexClientUserMessageId(
                input.userMessageId,
              ),
            }
          : {}),
        input: toCodexInput(input.content, input.selectedSkills),
        model: this.modelId,
        effort: this.reasoningEffort,
        summary: 'auto',
        ...this.turnPermissionParams(),
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
    const locator = parseCodexUserMessageId(input.sourceUserMessageId)
    const targetTurnIndex = thread.turns.findIndex((turn) => {
      if (locator.kind === 'turn') return turn.id === locator.id
      return turn.items.some(
        (item) =>
          item.type === 'userMessage' &&
          (locator.kind === 'client'
            ? item.clientId === locator.id
            : item.id === locator.id),
      )
    })
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
    this.activeSessionRef = toSessionRef(
      rollback.thread,
      this.options.mapRuntimePathToHost,
    )
    this.pendingRequests.clear()
    this.rawCustomToolRequests.clear()
    this.subagentWatches.clear()
    this.streamingAssistantText.clear()
    this.streamingReasoningSummaryParts.clear()
    this.streamingReasoningContentParts.clear()
    this.reasoningTrackers.clear()

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
    this.rawCustomToolRequests.clear()
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
    const [catalogResult, configResult] = await Promise.allSettled([
      this.fetchModelCatalog(host),
      host.request<ConfigReadResponse>('config/read', {
        cwd: this.options.cwd,
        includeLayers: false,
      }),
    ])
    const configuredModel =
      configResult.status === 'fulfilled'
        ? configResult.value.config.model
        : undefined
    this.modelId ??= configuredModel ?? null
    if (
      catalogResult.status === 'rejected' &&
      configResult.status === 'rejected'
    ) {
      throw catalogResult.reason
    }
    this.models = includeActiveCliModel(
      catalogResult.status === 'fulfilled' ? catalogResult.value : [],
      configuredModel,
    )
    return this.models
  }

  private async fetchModelCatalog(
    host: CodexAppServerHost,
  ): Promise<CliRuntimeConfiguration['models']> {
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
    return models
  }

  private handleHostFatal(error: Error): void {
    this.activeTurnId = null
    this.activeTurnStartedAt = null
    this.needsSessionRebind = true
    this.models = null
    this.modelId = null
    this.reasoningEffort = null
    this.pendingRequests.clear()
    this.rawCustomToolRequests.clear()
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
      this.handleSubagentNotification(threadId, method, params)
      return
    }
    if (method === 'turn/started') {
      const turn = params.turn as { id?: unknown } | undefined
      this.activeTurnId = typeof turn?.id === 'string' ? turn.id : null
      this.activeTurnStartedAt = Date.now()
      return
    }
    if (method === 'rawResponseItem/completed') {
      const item = params.item as CodexRawResponseItem | undefined
      if (!item) return
      if (item.type === 'custom_tool_call' || item.type === 'function_call') {
        const mapped = mapCodexRawToolCall(item)
        this.rawCustomToolRequests.set(item.call_id, mapped.requests)
        for (const message of mapped.messages) {
          this.emit({ type: 'message_upsert', message })
        }
      } else if (
        item.type === 'custom_tool_call_output' ||
        item.type === 'function_call_output'
      ) {
        const requests = this.rawCustomToolRequests.get(item.call_id)
        if (!requests) return
        this.rawCustomToolRequests.delete(item.call_id)
        for (const message of mapCodexRawToolOutput(item, requests)) {
          this.emit({ type: 'message_upsert', message })
        }
      }
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
      const tracker =
        this.reasoningTrackers.get(itemId) ?? new ReasoningPhaseTracker()
      tracker.observeReasoning()
      this.reasoningTrackers.set(itemId, tracker)
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
      if (item.type === 'contextCompaction') {
        const isCompacting = method === 'item/started'
        this.emit({ type: 'compaction_state', isCompacting })
        if (isCompacting) return
        this.emit({
          type: 'compaction_boundary',
          boundary: { id: `codex-compact-${item.id}` },
        })
        return
      }
      if (method === 'item/started' && item.type === 'reasoning') {
        this.reasoningTrackers.set(item.id, new ReasoningPhaseTracker())
      }
      if (method === 'item/started' && !shouldEmitCodexItemOnStarted(item)) {
        return
      }
      const turnId =
        typeof params.turnId === 'string' ? params.turnId : undefined
      if (item.type === 'reasoning' && method === 'item/completed') {
        this.reasoningTrackers.get(item.id)?.observeReasoning()
      }
      const reasoningDurationMs =
        item.type === 'reasoning' && method === 'item/completed'
          ? this.reasoningTrackers.get(item.id)?.settle()
          : undefined
      if (item.type === 'reasoning' && method === 'item/completed') {
        this.reasoningTrackers.delete(item.id)
      }
      for (const message of mapCodexItem(item, this.options.cwd, turnId)) {
        if (reasoningDurationMs !== undefined && message.role === 'assistant') {
          message.metadata = { ...message.metadata, reasoningDurationMs }
        }
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
      if (this.activeTurnStartedAt !== null) {
        this.emit({
          type: 'turn_metrics',
          durationMs: Math.max(0, Date.now() - this.activeTurnStartedAt),
        })
      }
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
      this.activeTurnStartedAt = null
      this.streamingReasoningSummaryParts.clear()
      this.streamingReasoningContentParts.clear()
      this.reasoningTrackers.clear()
      this.streamingAssistantText.clear()
      return
    }

    if (method === 'thread/tokenUsage/updated') {
      const turnUsage = mapCodexTurnResponseUsage(params)
      if (turnUsage) {
        this.emit({ type: 'turn_metrics', usage: turnUsage })
      }
      const usage = mapCodexTokenUsageUpdated(params)
      if (usage) {
        this.emit({ type: 'context_usage', usage })
      }
    }
  }

  private readonly streamingAssistantText = new Map<string, string>()
  private readonly streamingReasoningSummaryParts = new Map<string, string[]>()
  private readonly streamingReasoningContentParts = new Map<string, string[]>()
  private readonly reasoningTrackers = new Map<string, ReasoningPhaseTracker>()

  private handleSubagentNotification(
    threadId: string,
    method: string,
    params: Record<string, unknown>,
  ): void {
    const watch = this.subagentWatches.get(threadId)
    if (!watch) return

    if (method === 'item/agentMessage/delta') {
      const itemId =
        typeof params.itemId === 'string' ? params.itemId : 'stream'
      const delta = typeof params.delta === 'string' ? params.delta : ''
      const content = `${watch.assistantText.get(itemId) ?? ''}${delta}`
      watch.assistantText.set(itemId, content)
      upsertProjectedMessage(watch.messages, {
        role: 'assistant',
        id: `codex-assistant-${itemId}`,
        content,
        metadata: { generationState: 'streaming' },
      })
      this.publishSubagentWatch(watch)
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
        ? watch.reasoningSummaryParts
        : watch.reasoningContentParts
      const parts = target.get(itemId) ?? []
      parts[index] = `${parts[index] ?? ''}${delta}`
      target.set(itemId, parts)
      const reasoning = [
        ...(watch.reasoningSummaryParts.get(itemId) ?? []),
        ...(watch.reasoningContentParts.get(itemId) ?? []),
      ]
        .filter(Boolean)
        .join('\n\n')
      upsertProjectedMessage(watch.messages, {
        role: 'assistant',
        id: `codex-reasoning-${itemId}`,
        content: '',
        reasoning,
        metadata: { generationState: 'streaming' },
      })
      this.publishSubagentWatch(watch)
      return
    }

    if (method === 'item/started' || method === 'item/completed') {
      const item = params.item as CodexThreadItem | undefined
      if (!item) return
      if (method === 'item/started' && !shouldEmitCodexItemOnStarted(item)) {
        return
      }
      const turnId =
        typeof params.turnId === 'string' ? params.turnId : undefined
      for (const message of mapCodexItem(item, this.options.cwd, turnId)) {
        upsertProjectedMessage(watch.messages, message)
      }
      this.publishSubagentWatch(watch)
    }
  }

  private publishSubagentWatch(watch: CodexSubagentWatch): void {
    const messages = [...watch.messages]
    for (const listener of watch.listeners) listener(messages)
  }

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
            ? 'commandExecution'
            : request.method === 'item/fileChange/requestApproval'
              ? 'fileChange'
              : 'permissions',
        argumentsValue: request.params,
        responseStatus: ToolCallResponseStatus.PendingApproval,
        cliToolCall: {
          runtimeId: 'codex',
          eventType: request.method,
          name:
            request.method === 'item/commandExecution/requestApproval'
              ? 'commandExecution'
              : request.method === 'item/fileChange/requestApproval'
                ? 'fileChange'
                : 'permissions',
          capability:
            request.method === 'item/commandExecution/requestApproval'
              ? 'command_execution'
              : request.method === 'item/fileChange/requestApproval'
                ? 'file_change'
                : 'permission_request',
        },
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
        name: 'requestUserInput',
        argumentsValue: request.params,
        responseStatus: ToolCallResponseStatus.AwaitingUserInput,
        cliToolCall: {
          runtimeId: 'codex',
          eventType: request.method,
          name: 'requestUserInput',
          capability: 'user_question',
          presentationArguments: { questions },
        },
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
