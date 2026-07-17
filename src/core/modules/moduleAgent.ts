import type { ChatAssistantMessage, ChatUserMessage } from '../../types/chat'
import type {
  YoloAgentApi,
  YoloAgentEvent,
  YoloAgentRunRequest,
} from '../agent/agent-api'
import { getLocalFileToolServerName } from '../mcp/localFileToolNames'
import { getToolName } from '../mcp/tool-name-utils'

import type { ModuleLifecycleScope } from './lifecycleScope'
import type {
  YoloModuleAgentCapabilityV1,
  YoloModuleAgentEventV1,
  YoloModuleAgentMessageV1,
  YoloModuleAgentRequestV1,
  YoloModuleAgentV1,
} from './types'

export type ModuleAgentCapabilityActivationV1 = Readonly<{
  api: YoloModuleAgentV1
  activate(): void
}>

export type ModuleAgentCapabilityProviderV1 = {
  create(
    moduleId: string,
    lifecycle: ModuleLifecycleScope,
  ): ModuleAgentCapabilityActivationV1
}

export type CoreModuleAgentCapabilityProviderOptions = {
  getAgentApi(): Promise<YoloAgentApi>
}

const localFileToolName = (name: string): string =>
  getToolName(getLocalFileToolServerName(), name)

const TOOL_NAMES = Object.freeze({
  read: localFileToolName('fs_read'),
  list: localFileToolName('fs_list'),
  edit: localFileToolName('fs_edit'),
})

const TOOLS_BY_CAPABILITY: Readonly<
  Record<YoloModuleAgentCapabilityV1, readonly string[]>
> = Object.freeze({
  none: Object.freeze([]),
  'vault-read': Object.freeze([TOOL_NAMES.read, TOOL_NAMES.list]),
  'vault-write': Object.freeze([
    TOOL_NAMES.read,
    TOOL_NAMES.list,
    TOOL_NAMES.edit,
  ]),
})

export const UNAVAILABLE_MODULE_AGENT_CAPABILITY_PROVIDER: ModuleAgentCapabilityProviderV1 =
  Object.freeze({
    create: () => ({
      api: Object.freeze({
        stream: async function* () {
          yield* [] as YoloModuleAgentEventV1[]
          throw new Error('Module agent capability is unavailable')
        },
      }),
      activate: () => undefined,
    }),
  })

export class CoreModuleAgentCapabilityProvider
  implements ModuleAgentCapabilityProviderV1
{
  constructor(
    private readonly options: CoreModuleAgentCapabilityProviderOptions,
  ) {}

  create(
    moduleId: string,
    lifecycle: ModuleLifecycleScope,
  ): ModuleAgentCapabilityActivationV1 {
    let active = true
    let activationComplete = false
    const controllers = new Set<AbortController>()
    lifecycle.add(() => {
      active = false
      activationComplete = false
      for (const controller of controllers) controller.abort()
      controllers.clear()
    })

    const assertAvailable = (): void => {
      if (!active) throw new Error(`Module "${moduleId}" is no longer active`)
      if (!activationComplete) {
        throw new Error(`Module "${moduleId}" agent is not active`)
      }
    }
    const api: YoloModuleAgentV1 = Object.freeze({
      stream: (request) => {
        assertAvailable()
        const snapshot = snapshotRequest(request)
        return this.streamRequest(snapshot, controllers, assertAvailable)
      },
    })
    return Object.freeze({
      api,
      activate: () => {
        if (!active) throw new Error(`Module "${moduleId}" is no longer active`)
        activationComplete = true
      },
    })
  }

  private async *streamRequest(
    request: YoloModuleAgentRequestV1,
    controllers: Set<AbortController>,
    assertAvailable: () => void,
  ): AsyncIterable<YoloModuleAgentEventV1> {
    const controller = new AbortController()
    controllers.add(controller)
    const abort = (): void => controller.abort()
    if (request.signal?.aborted) abort()
    else request.signal?.addEventListener('abort', abort, { once: true })
    let terminal = false
    let coreDone = false
    let iterator: AsyncIterator<YoloAgentEvent> | null = null
    try {
      assertAvailable()
      if (controller.signal.aborted) {
        terminal = true
        yield Object.freeze({ type: 'aborted' })
        return
      }
      const agentResult = await raceAbort(
        this.options.getAgentApi(),
        controller.signal,
      )
      if (agentResult.aborted) {
        terminal = true
        yield Object.freeze({ type: 'aborted' })
        return
      }
      const agent = agentResult.value
      assertAvailable()
      if (controller.signal.aborted) {
        terminal = true
        yield Object.freeze({ type: 'aborted' })
        return
      }
      const coreStream = agent.stream(mapRequest(request, controller.signal))
      iterator = coreStream[Symbol.asyncIterator]()
      while (true) {
        const nextResult = await raceAbort(iterator.next(), controller.signal)
        if (nextResult.aborted) {
          terminal = true
          yield Object.freeze({ type: 'aborted' })
          return
        }
        if (nextResult.value.done) {
          coreDone = true
          break
        }
        const event = nextResult.value.value
        if (controller.signal.aborted) {
          terminal = true
          yield Object.freeze({ type: 'aborted' })
          return
        }
        const mapped = mapEvent(event)
        if (!mapped) continue
        const isTerminal =
          mapped.type === 'completed' ||
          mapped.type === 'aborted' ||
          mapped.type === 'error'
        if (isTerminal) {
          terminal = true
        }
        yield controller.signal.aborted
          ? Object.freeze({ type: 'aborted' })
          : mapped
        if (isTerminal) return
      }
      if (!terminal && controller.signal.aborted) {
        yield Object.freeze({ type: 'aborted' })
      }
    } catch (error) {
      if (!terminal) {
        if (controller.signal.aborted) {
          yield Object.freeze({ type: 'aborted' })
        } else {
          yield Object.freeze({
            type: 'error',
            message: sanitizeErrorMessage(describeError(error)),
          })
        }
      }
    } finally {
      controller.abort()
      if (iterator && !coreDone) safelyReturn(iterator)
      controllers.delete(controller)
      request.signal?.removeEventListener('abort', abort)
    }
  }
}

function snapshotRequest(
  request: YoloModuleAgentRequestV1,
): YoloModuleAgentRequestV1 {
  if (!request || typeof request !== 'object') {
    throw new TypeError('Module agent request must be an object')
  }
  const prompt = request.prompt
  const messages = request.messages
  const modelId = request.modelId
  const systemPrompt = request.systemPrompt
  const capability = request.capability
  const workspaceScope = request.workspaceScope
  const signal = request.signal
  if (prompt !== undefined && typeof prompt !== 'string') {
    throw new TypeError('Module agent prompt must be a string')
  }
  if (!Array.isArray(messages) && messages !== undefined) {
    throw new TypeError('Module agent messages must be an array')
  }
  if (prompt !== undefined && messages !== undefined) {
    throw new Error('Module agent prompt and messages are mutually exclusive')
  }
  if (prompt !== undefined && !prompt.trim()) {
    throw new Error('Module agent prompt must not be empty')
  }
  if (messages !== undefined && messages.length === 0) {
    throw new Error('Module agent messages must not be empty')
  }
  if (prompt === undefined && messages === undefined) {
    throw new Error('Module agent request requires prompt or messages')
  }
  if (
    modelId !== undefined &&
    (typeof modelId !== 'string' || !modelId.trim())
  ) {
    throw new TypeError('Module agent model id must be a string')
  }
  if (typeof systemPrompt !== 'string') {
    throw new TypeError('Module agent system prompt must be a string')
  }
  if (
    capability !== 'none' &&
    capability !== 'vault-read' &&
    capability !== 'vault-write'
  ) {
    throw new Error('Module agent capability is invalid')
  }
  if (signal !== undefined && !isAbortSignal(signal)) {
    throw new TypeError('Module agent signal must be an AbortSignal')
  }
  if (
    workspaceScope !== undefined &&
    (!workspaceScope || typeof workspaceScope !== 'object')
  ) {
    throw new TypeError('Module agent workspace scope is invalid')
  }
  const snappedMessages = messages?.map(snapshotMessage)
  if (
    snappedMessages &&
    snappedMessages[snappedMessages.length - 1]?.role !== 'user'
  ) {
    throw new Error('Module agent messages must end with a user message')
  }
  return Object.freeze({
    ...(prompt !== undefined ? { prompt } : {}),
    ...(snappedMessages !== undefined
      ? { messages: Object.freeze(snappedMessages) }
      : {}),
    ...(modelId !== undefined ? { modelId } : {}),
    systemPrompt,
    capability,
    ...(workspaceScope !== undefined
      ? { workspaceScope: snapshotWorkspaceScope(workspaceScope) }
      : {}),
    ...(signal ? { signal } : {}),
  })
}

function snapshotMessage(
  message: YoloModuleAgentMessageV1,
): YoloModuleAgentMessageV1 {
  if (!message || typeof message !== 'object') {
    throw new TypeError('Module agent message must be an object')
  }
  if (message.role !== 'user' && message.role !== 'assistant') {
    throw new Error('Module agent message role is invalid')
  }
  if (typeof message.id !== 'string' || !message.id) {
    throw new Error('Module agent message id must be a non-empty string')
  }
  if (typeof message.content !== 'string') {
    throw new TypeError('Module agent message content must be a string')
  }
  return Object.freeze({
    role: message.role,
    id: message.id,
    content: message.content,
  })
}

function snapshotWorkspaceScope(
  scope: NonNullable<YoloModuleAgentRequestV1['workspaceScope']>,
): NonNullable<YoloModuleAgentRequestV1['workspaceScope']> {
  if (
    !scope ||
    typeof scope !== 'object' ||
    typeof scope.enabled !== 'boolean'
  ) {
    throw new TypeError('Module agent workspace scope is invalid')
  }
  if (!Array.isArray(scope.include) || !Array.isArray(scope.exclude)) {
    throw new TypeError('Module agent workspace paths must be arrays')
  }
  const include = scope.include.map(snapshotPath)
  const exclude = scope.exclude.map(snapshotPath)
  return Object.freeze({
    enabled: scope.enabled,
    include: Object.freeze(include),
    exclude: Object.freeze(exclude),
  })
}

function snapshotPath(path: string): string {
  if (typeof path !== 'string') {
    throw new TypeError('Module agent workspace path must be a string')
  }
  return path
}

function mapRequest(
  request: YoloModuleAgentRequestV1,
  abortSignal: AbortSignal,
): YoloAgentRunRequest {
  return {
    ...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
    ...(request.messages ? { messages: request.messages.map(mapMessage) } : {}),
    ...(request.modelId !== undefined ? { modelId: request.modelId } : {}),
    mode: 'agent',
    yolo: true,
    systemPromptOverride: request.systemPrompt,
    tools: {
      allowedToolNames: [...TOOLS_BY_CAPABILITY[request.capability]],
    },
    ...(request.workspaceScope
      ? {
          workspaceScope: {
            enabled: request.workspaceScope.enabled,
            include: [...request.workspaceScope.include],
            exclude: [...request.workspaceScope.exclude],
          },
        }
      : {}),
    abortSignal,
  }
}

function mapMessage(
  message: YoloModuleAgentMessageV1,
): ChatUserMessage | ChatAssistantMessage {
  if (message.role === 'user') {
    return {
      role: 'user',
      id: message.id,
      content: null,
      promptContent: message.content,
      mentionables: [],
    }
  }
  return { role: 'assistant', id: message.id, content: message.content }
}

function mapEvent(event: YoloAgentEvent): YoloModuleAgentEventV1 | null {
  switch (event.type) {
    case 'state':
      return event.status === 'aborted'
        ? Object.freeze({ type: 'aborted' })
        : null
    case 'text':
      return Object.freeze({
        type: 'text',
        text: event.text,
        delta: event.delta,
      })
    case 'tool':
      return Object.freeze({
        type: 'tool',
        name: publicToolName(event.name),
        status: event.status,
        ...(event.arguments
          ? { arguments: Object.freeze({ ...event.arguments }) }
          : {}),
      })
    case 'completed':
      return Object.freeze({ type: 'completed', text: event.text })
    case 'error':
      return Object.freeze({
        type: 'error',
        message: sanitizeErrorMessage(event.message),
      })
  }
}

function publicToolName(name: string): string {
  if (name === TOOL_NAMES.read) return 'vault.read'
  if (name === TOOL_NAMES.list) return 'vault.list'
  if (name === TOOL_NAMES.edit) return 'vault.edit'
  return 'unknown'
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AbortSignal).aborted === 'boolean' &&
    typeof (value as AbortSignal).addEventListener === 'function' &&
    typeof (value as AbortSignal).removeEventListener === 'function'
  )
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sanitizeErrorMessage(message: string): string {
  return message.replace(/[A-Za-z0-9_-]+__[A-Za-z0-9_-]+/g, 'internal tool')
}

type AbortRace<T> =
  | Readonly<{ aborted: true }>
  | Readonly<{ aborted: false; value: T }>

function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<AbortRace<T>> {
  if (signal.aborted) return Promise.resolve({ aborted: true })
  return new Promise<AbortRace<T>>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup()
      resolve({ aborted: true })
    }
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => {
        cleanup()
        resolve({ aborted: false, value })
      },
      (error: unknown) => {
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

function safelyReturn(iterator: AsyncIterator<YoloAgentEvent>): void {
  try {
    void iterator.return?.().catch(() => undefined)
  } catch {
    // The Core iterator is already being abandoned; cleanup is best effort.
  }
}
