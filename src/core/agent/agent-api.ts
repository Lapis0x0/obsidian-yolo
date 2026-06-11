import type { App } from 'obsidian'
import { v4 as uuidv4 } from 'uuid'

import { resolveWorkspaceScopeForRuntimeInput } from '../../components/chat-view/chat-runtime-inputs'
import { resolveChatModeRuntime } from '../../components/chat-view/chat-runtime-profiles'
import type { YoloSettings } from '../../settings/schema/setting.types'
import type {
  ChatAssistantMessage,
  ChatMessage,
  ChatToolMessage,
  ChatUserMessage,
} from '../../types/chat'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { RequestContextBuilder } from '../../utils/chat/requestContextBuilder'
import { getChatModelClient } from '../llm/manager'
import type { McpManager } from '../mcp/mcpManager'
import { listLiteSkillEntries } from '../skills/liteSkills'
import { isSkillEnabledForAssistant } from '../skills/skillPolicy'

import { resolveAgentApiContext } from './agent-api-context'
import { DEFAULT_ASSISTANT_ID } from './default-assistant'
import type {
  AgentConversationState,
  AgentRunStatus,
  AgentService,
} from './service'
import { getEnabledAssistantToolNames } from './tool-preferences'
import type { AgentRuntimeLoopConfig, AgentRuntimeRunInput } from './types'

export type YoloAgentContext =
  | { type: 'file'; path: string }
  | { type: 'folder'; path: string }
  | { type: 'skill'; name: string }
  | { type: 'markdown'; path?: string; content: string }
  | { type: 'canvas'; path?: string; content: string }
  | { type: 'text'; content: string }

export type YoloAgentRunRequest = {
  prompt: string
  assistantId?: string
  mode?: 'ask' | 'agent' | 'agent-full'
  context?: YoloAgentContext[]
  tools?: {
    allowedToolNames?: string[]
  }
  abortSignal?: AbortSignal
}

export type YoloAgentRunResult = {
  conversationId: string
  text: string
  status: 'completed' | 'aborted' | 'error'
  errorMessage?: string
}

export type YoloAgentEvent =
  | {
      type: 'state'
      conversationId: string
      status: AgentRunStatus
    }
  | {
      type: 'text'
      conversationId: string
      messageId: string
      text: string
      delta: string
      streaming: boolean
    }
  | {
      type: 'tool'
      conversationId: string
      toolCallId: string
      name: string
      status:
        | 'pending'
        | 'running'
        | 'completed'
        | 'error'
        | 'awaiting_approval'
    }
  | {
      type: 'completed'
      conversationId: string
      text: string
    }
  | {
      type: 'error'
      conversationId: string
      message: string
    }

export type YoloAgentApi = {
  run(request: YoloAgentRunRequest): Promise<YoloAgentRunResult>
  stream(request: YoloAgentRunRequest): AsyncIterable<YoloAgentEvent>
  abort(conversationId: string): boolean
}

type AgentApiRunInput = {
  conversationId: string
  sourceUserMessageId: string
  loopConfig: AgentRuntimeLoopConfig
  input: AgentRuntimeRunInput
}

export type YoloAgentApiServiceOptions = {
  app: App
  getSettings: () => YoloSettings
  getAgentService: () => AgentService
  getMcpManager: () => Promise<McpManager>
}

export class YoloAgentApiService implements YoloAgentApi {
  private readonly abortControllers = new Map<string, AbortController>()

  constructor(private readonly options: YoloAgentApiServiceOptions) {}

  async run(request: YoloAgentRunRequest): Promise<YoloAgentRunResult> {
    let conversationId = ''
    let text = ''
    let errorMessage: string | undefined
    let status: YoloAgentRunResult['status'] = 'completed'

    for await (const event of this.stream(request)) {
      conversationId = event.conversationId
      if (event.type === 'text' || event.type === 'completed') {
        text = event.text
      }
      if (event.type === 'state' && event.status === 'aborted') {
        status = 'aborted'
      }
      if (event.type === 'error') {
        status = 'error'
        errorMessage = event.message
      }
    }

    return {
      conversationId,
      text,
      status,
      ...(errorMessage ? { errorMessage } : {}),
    }
  }

  async *stream(request: YoloAgentRunRequest): AsyncIterable<YoloAgentEvent> {
    const conversationId = uuidv4()
    const abortController = new AbortController()
    const abortExternal = () => abortController.abort()

    this.abortControllers.set(conversationId, abortController)
    if (request.abortSignal) {
      if (request.abortSignal.aborted) {
        abortController.abort()
      } else {
        request.abortSignal.addEventListener('abort', abortExternal, {
          once: true,
        })
      }
    }

    try {
      const resolved = await resolveAgentApiRunInput({
        request,
        conversationId,
        abortSignal: abortController.signal,
        app: this.options.app,
        settings: this.options.getSettings(),
        agentService: this.options.getAgentService(),
        mcpManager: await this.options.getMcpManager(),
      })

      for await (const event of streamResolvedAgentRunEvents({
        conversationId,
        sourceUserMessageId: resolved.sourceUserMessageId,
        loopConfig: resolved.loopConfig,
        input: resolved.input,
        agentService: this.options.getAgentService(),
      })) {
        yield event
      }
    } catch (error) {
      yield {
        type: 'error',
        conversationId,
        message: normalizeErrorMessage(error),
      }
    } finally {
      abortController.abort()
      request.abortSignal?.removeEventListener('abort', abortExternal)
      this.abortControllers.delete(conversationId)
    }
  }

  abort(conversationId: string): boolean {
    const controller = this.abortControllers.get(conversationId)
    controller?.abort()
    const serviceAborted = this.options
      .getAgentService()
      .abortConversation(conversationId)
    return Boolean(controller) || serviceAborted
  }
}

export async function* streamResolvedAgentRunEvents({
  conversationId,
  sourceUserMessageId,
  loopConfig,
  input,
  agentService,
}: {
  conversationId: string
  sourceUserMessageId: string
  loopConfig: AgentRuntimeLoopConfig
  input: AgentRuntimeRunInput
  agentService: AgentService
}): AsyncIterable<YoloAgentEvent> {
  const queue = new AsyncEventQueue<YoloAgentEvent>()
  let previous = createEmptySnapshotTracker()
  let settled = false

  const unsubscribe = agentService.subscribe(
    conversationId,
    (state) => {
      const nextEvents = conversationStateToEvents({
        state,
        sourceUserMessageId,
        previous,
      })
      previous = nextEvents.nextTracker
      for (const event of nextEvents.events) {
        queue.push(event)
      }
      if (
        state.status === 'completed' ||
        state.status === 'aborted' ||
        state.status === 'error'
      ) {
        settled = true
        queue.close()
      }
    },
    { emitCurrent: false },
  )

  void agentService
    .run({
      conversationId,
      persistState: false,
      loopConfig,
      input,
    })
    .catch((error) => {
      queue.push({
        type: 'error',
        conversationId,
        message: normalizeErrorMessage(error),
      })
      settled = true
      queue.close()
    })

  try {
    for await (const event of queue) {
      yield event
    }
  } finally {
    if (!settled) {
      agentService.abortConversation(conversationId)
    }
    unsubscribe()
  }
}

export async function resolveAgentApiRunInput({
  request,
  conversationId,
  abortSignal,
  app,
  settings,
  agentService,
  mcpManager,
}: {
  request: YoloAgentRunRequest
  conversationId: string
  abortSignal: AbortSignal
  app: App
  settings: YoloSettings
  agentService: AgentService
  mcpManager: McpManager
}): Promise<AgentApiRunInput> {
  const assistantId =
    request.assistantId ?? settings.currentAssistantId ?? DEFAULT_ASSISTANT_ID
  const assistant =
    settings.assistants.find((candidate) => candidate.id === assistantId) ??
    null
  const requestedModelId = assistant?.modelId || settings.chatModelId
  const resolvedClient = getChatModelClient({
    settings,
    modelId: requestedModelId,
  })
  const provider = settings.providers.find(
    (candidate) => candidate.id === resolvedClient.model.providerId,
  )
  const assistantEnabledToolNames = getEnabledAssistantToolNames(assistant)
  const chatModeRuntime = resolveChatModeRuntime({
    mode: request.mode ?? 'ask',
    assistant,
    assistantEnabledToolNames,
  })
  const allowedToolNames = narrowAllowedToolNames(
    chatModeRuntime.allowedToolNames,
    request.tools?.allowedToolNames,
  )
  const allowedSkillPaths = await resolveAllowedSkillPaths({
    app,
    settings,
    assistant,
  })
  const requestContextBuilder = new RequestContextBuilder(
    app,
    {
      ...settings,
      currentAssistantId: assistant?.id,
    },
    {
      includeSkills: true,
      systemPromptSnapshotStore: agentService.getSystemPromptSnapshotStore(),
      getPromptSourceRevision: () =>
        agentService.getPromptSourceWatcher().getRevision(),
      promptSourcePathsCallback: (paths) =>
        agentService.getPromptSourceWatcher().setWatchedPaths(paths),
    },
  )
  const resolvedContext = await resolveAgentApiContext({
    app,
    settings,
    context: request.context,
  })
  const compiledPrompt =
    await requestContextBuilder.compilePlainUserMessagePrompt({
      prompt: buildAgentApiPrompt({
        prompt: request.prompt,
        context: resolvedContext.textBlocks,
      }),
      mentionables: resolvedContext.mentionables,
      selectedSkills: resolvedContext.selectedSkills,
    })
  const sourceUserMessageId = uuidv4()
  const messages = [
    buildAgentApiUserMessage({
      id: sourceUserMessageId,
      promptContent: compiledPrompt.promptContent,
      mentionables: resolvedContext.mentionables,
      selectedSkills: resolvedContext.selectedSkills,
    }),
  ]

  return {
    conversationId,
    sourceUserMessageId,
    loopConfig: chatModeRuntime.loopConfig,
    input: {
      providerClient: resolvedClient.providerClient,
      model: resolvedClient.model,
      apiType: provider?.apiType ?? null,
      messages,
      conversationId,
      assistantId: assistant?.id,
      sourceUserMessageId,
      requestContextBuilder,
      mcpManager,
      abortSignal,
      allowedToolNames,
      enableToolDisclosure: settings.mcp.enableToolDisclosure,
      toolPreferences: chatModeRuntime.toolPreferences,
      runtimeModePrompt: chatModeRuntime.runtimeModePrompt,
      bypassToolApproval: chatModeRuntime.bypassToolApproval,
      workspaceScope: resolveWorkspaceScopeForRuntimeInput(assistant),
      allowedSkillPaths,
      requestParams: {
        stream: true,
        primaryRequestTimeoutMs:
          settings.continuationOptions.primaryRequestTimeoutMs,
        streamFallbackRecoveryEnabled:
          settings.continuationOptions.streamFallbackRecoveryEnabled,
      },
    },
  }
}

export function buildAgentApiPrompt({
  prompt,
  context,
}: {
  prompt: string
  context?: Array<
    Extract<YoloAgentContext, { type: 'text' | 'markdown' | 'canvas' }>
  >
}): string {
  const blocks = (context ?? []).map((entry) => {
    if (entry.type === 'markdown') {
      const label = entry.path
        ? `Markdown context: ${entry.path}`
        : 'Markdown context'
      return `${label}\n\n\`\`\`markdown\n${entry.content}\n\`\`\``
    }
    if (entry.type === 'canvas') {
      const label = entry.path
        ? `Canvas context: ${entry.path}`
        : 'Canvas context'
      return `${label}\n\n\`\`\`json\n${entry.content}\n\`\`\``
    }
    return entry.content
  })

  return [prompt, ...blocks]
    .filter((part) => part.trim().length > 0)
    .join('\n\n')
}

export function buildAgentApiUserMessage({
  id,
  promptContent,
  mentionables,
  selectedSkills,
}: {
  id: string
  promptContent: ChatUserMessage['promptContent']
  mentionables: ChatUserMessage['mentionables']
  selectedSkills?: ChatUserMessage['selectedSkills']
}): ChatUserMessage {
  return {
    role: 'user',
    id,
    content: null,
    promptContent,
    mentionables,
    selectedSkills,
  }
}

export function narrowAllowedToolNames(
  runtimeAllowedToolNames: string[] | undefined,
  requestedAllowedToolNames: string[] | undefined,
): string[] | undefined {
  if (!runtimeAllowedToolNames || !requestedAllowedToolNames) {
    return runtimeAllowedToolNames
  }

  const requested = new Set(requestedAllowedToolNames)
  return runtimeAllowedToolNames.filter((name) => requested.has(name))
}

export function conversationStateToEvents({
  state,
  sourceUserMessageId,
  previous,
}: {
  state: AgentConversationState
  sourceUserMessageId: string
  previous: SnapshotTracker
}): { events: YoloAgentEvent[]; nextTracker: SnapshotTracker } {
  const events: YoloAgentEvent[] = [
    {
      type: 'state',
      conversationId: state.conversationId,
      status: state.status,
    },
  ]
  const assistantMessage = findAssistantMessageForUser(
    state.messages,
    sourceUserMessageId,
  )
  const nextTracker: SnapshotTracker = {
    assistantTextById: new Map(previous.assistantTextById),
    toolStatusById: new Map(previous.toolStatusById),
  }
  let currentText = ''

  if (assistantMessage) {
    const previousText =
      previous.assistantTextById.get(assistantMessage.id) ?? ''
    currentText = assistantMessage.content
    const delta = currentText.startsWith(previousText)
      ? currentText.slice(previousText.length)
      : ''
    nextTracker.assistantTextById.set(assistantMessage.id, currentText)

    if (delta.length > 0 || previousText !== currentText) {
      events.push({
        type: 'text',
        conversationId: state.conversationId,
        messageId: assistantMessage.id,
        text: currentText,
        delta,
        streaming:
          assistantMessage.metadata?.generationState === 'streaming' &&
          state.status === 'running',
      })
    }
  }

  for (const event of toolEventsFromMessages({
    conversationId: state.conversationId,
    messages: state.messages,
    sourceUserMessageId,
    previous,
    nextTracker,
  })) {
    events.push(event)
  }

  if (state.status === 'completed') {
    events.push({
      type: 'completed',
      conversationId: state.conversationId,
      text: currentText,
    })
  } else if (state.status === 'error') {
    events.push({
      type: 'error',
      conversationId: state.conversationId,
      message: state.errorMessage ?? 'Agent run failed',
    })
  }

  return { events, nextTracker }
}

type SnapshotTracker = {
  assistantTextById: Map<string, string>
  toolStatusById: Map<string, YoloAgentEvent & { type: 'tool' }>
}

function createEmptySnapshotTracker(): SnapshotTracker {
  return {
    assistantTextById: new Map(),
    toolStatusById: new Map(),
  }
}

function findAssistantMessageForUser(
  messages: ChatMessage[],
  sourceUserMessageId: string,
): ChatAssistantMessage | null {
  const metadataMatch = messages.find(
    (message): message is ChatAssistantMessage =>
      message.role === 'assistant' &&
      message.metadata?.sourceUserMessageId === sourceUserMessageId,
  )
  if (metadataMatch) {
    return metadataMatch
  }

  const userIndex = messages.findIndex(
    (message) => message.role === 'user' && message.id === sourceUserMessageId,
  )
  if (userIndex < 0) {
    return null
  }

  for (const message of messages.slice(userIndex + 1)) {
    if (message.role === 'user') {
      return null
    }
    if (message.role === 'assistant') {
      return message
    }
  }

  return null
}

function toolEventsFromMessages({
  conversationId,
  messages,
  sourceUserMessageId,
  previous,
  nextTracker,
}: {
  conversationId: string
  messages: ChatMessage[]
  sourceUserMessageId: string
  previous: SnapshotTracker
  nextTracker: SnapshotTracker
}): Array<YoloAgentEvent & { type: 'tool' }> {
  const events: Array<YoloAgentEvent & { type: 'tool' }> = []
  const relevantToolMessages = messages.filter(
    (message): message is ChatToolMessage =>
      message.role === 'tool' &&
      message.metadata?.sourceUserMessageId === sourceUserMessageId,
  )

  for (const message of relevantToolMessages) {
    for (const toolCall of message.toolCalls) {
      const event: YoloAgentEvent & { type: 'tool' } = {
        type: 'tool',
        conversationId,
        toolCallId: toolCall.request.id,
        name: toolCall.request.name,
        status: mapToolStatus(toolCall.response.status),
      }
      const previousEvent = previous.toolStatusById.get(event.toolCallId)
      nextTracker.toolStatusById.set(event.toolCallId, event)
      if (!previousEvent || previousEvent.status !== event.status) {
        events.push(event)
      }
    }
  }

  return events
}

function mapToolStatus(
  status: ToolCallResponseStatus,
): Extract<YoloAgentEvent, { type: 'tool' }>['status'] {
  switch (status) {
    case ToolCallResponseStatus.PendingApproval:
    case ToolCallResponseStatus.AwaitingUserInput:
      return 'awaiting_approval'
    case ToolCallResponseStatus.Running:
      return 'running'
    case ToolCallResponseStatus.Success:
      return 'completed'
    case ToolCallResponseStatus.Error:
    case ToolCallResponseStatus.Rejected:
    case ToolCallResponseStatus.Aborted:
      return 'error'
    default:
      return 'pending'
  }
}

async function resolveAllowedSkillPaths({
  app,
  settings,
  assistant,
}: {
  app: App
  settings: YoloSettings
  assistant: YoloSettings['assistants'][number] | null
}): Promise<string[]> {
  if (!assistant) {
    return []
  }

  const disabledSkillNames = settings.skills?.disabledSkillIds ?? []
  const skillEntries = await listLiteSkillEntries(app, { settings })
  return skillEntries
    .filter((skill) =>
      isSkillEnabledForAssistant({
        assistant,
        skillName: skill.name,
        disabledSkillNames,
      }),
    )
    .map((skill) => skill.path)
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  return JSON.stringify(error)
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []
  private closed = false

  push(value: T): void {
    if (this.closed) {
      return
    }
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ done: false, value })
      return
    }
    this.values.push(value)
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: true, value: undefined })
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const next = await this.next()
      if (next.done) {
        return
      }
      yield next.value
    }
  }

  private next(): Promise<IteratorResult<T>> {
    const value = this.values.shift()
    if (value) {
      return Promise.resolve({ done: false, value })
    }
    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined })
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve)
    })
  }
}
