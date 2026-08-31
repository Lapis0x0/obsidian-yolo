import { v4 as uuidv4 } from 'uuid'

import type { ChatAssistantMessage, ChatUserMessage } from '../../types/chat'
import type { McpTool } from '../../types/mcp.types'
import {
  type ToolCallResponse,
  ToolCallResponseStatus,
} from '../../types/tool-call.types'
import type {
  YoloAgentApi,
  YoloAgentEvent,
  YoloAgentRunRequest,
} from '../agent/agent-api'
import type { InProcessToolServer } from '../mcp/inProcessToolServer'
import { getToolName } from '../mcp/tool-name-utils'

import type { ModuleLifecycleScope } from './lifecycleScope'
import { ModuleAgentDebugCollector } from './moduleAgentDebugLog'
import {
  MODULE_CAPABILITY_TOOL_NAMES,
  resolveModuleCapabilityProfile,
} from './moduleCapabilityProfile'
import { assertModuleId } from './moduleStore'
import type {
  YoloModuleAgentEventV1,
  YoloModuleAgentMessageV1,
  YoloModuleAgentRequestV1,
  YoloModuleAgentToolV1,
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
  isDebugCaptureEnabled(): boolean
}

export const MODULE_AGENT_TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/
export const MAX_MODULE_AGENT_TOOLS = 16

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
    assertModuleId(moduleId, 'Module id')
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
        return this.streamRequest(
          snapshot,
          moduleId,
          controllers,
          assertAvailable,
        )
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
    moduleId: string,
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
    let debug: ModuleAgentDebugCollector | null = null
    const toolContext = buildModuleToolRuntimeContext(request, moduleId)
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
      const coreStream = agent.stream(
        mapRequest(request, moduleId, controller.signal, toolContext),
      )
      if (this.options.isDebugCaptureEnabled()) {
        debug = new ModuleAgentDebugCollector(moduleId, request)
      }
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
        const mapped = mapEvent(event, toolContext.publicNameByFullName)
        if (!mapped) continue
        debug?.record(mapped)
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
          const mapped = Object.freeze({
            type: 'error',
            message: sanitizeErrorMessage(
              describeError(error),
              toolContext.publicNameByFullName,
            ),
          }) satisfies YoloModuleAgentEventV1
          debug?.record(mapped)
          yield mapped
        }
      }
    } finally {
      if (this.options.isDebugCaptureEnabled()) debug?.emit()
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
  const activity = request.activity
  const tools = request.tools
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
  const snappedActivity =
    activity === undefined ? undefined : snapshotActivity(activity)
  const snappedMessages = messages?.map(snapshotMessage)
  if (
    snappedMessages &&
    snappedMessages[snappedMessages.length - 1]?.role !== 'user'
  ) {
    throw new Error('Module agent messages must end with a user message')
  }
  const snappedTools = tools === undefined ? undefined : snapshotTools(tools)
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
    ...(snappedActivity !== undefined ? { activity: snappedActivity } : {}),
    ...(snappedTools !== undefined ? { tools: snappedTools } : {}),
    ...(signal ? { signal } : {}),
  })
}

function snapshotTools(
  tools: NonNullable<YoloModuleAgentRequestV1['tools']>,
): NonNullable<YoloModuleAgentRequestV1['tools']> {
  if (!Array.isArray(tools)) {
    throw new TypeError('Module agent tools must be an array')
  }
  if (tools.length > MAX_MODULE_AGENT_TOOLS) {
    throw new Error(
      `Module agent tools must not exceed ${MAX_MODULE_AGENT_TOOLS}`,
    )
  }
  const snapped = tools.map(snapshotModuleAgentToolBase)
  const names = new Set<string>()
  for (const tool of snapped) {
    if (names.has(tool.name)) {
      throw new Error(`Module agent tool name "${tool.name}" is duplicated`)
    }
    names.add(tool.name)
  }
  return Object.freeze(snapped)
}

/**
 * Validates and snapshots the fields shared by every module tool contract:
 * name/description/inputSchema/handler. Exported so `moduleChatModeRegistry.ts`
 * can validate its (superset) tool declaration identically instead of
 * re-implementing the same checks.
 */
export function snapshotModuleAgentToolBase(
  tool: YoloModuleAgentToolV1,
): YoloModuleAgentToolV1 {
  if (!tool || typeof tool !== 'object') {
    throw new TypeError('Module agent tool must be an object')
  }
  if (
    typeof tool.name !== 'string' ||
    !MODULE_AGENT_TOOL_NAME_RE.test(tool.name)
  ) {
    throw new TypeError('Module agent tool name must match ^[a-z][a-z0-9_]*$')
  }
  if (typeof tool.description !== 'string' || !tool.description.trim()) {
    throw new TypeError(
      'Module agent tool description must be a non-empty string',
    )
  }
  if (
    !tool.inputSchema ||
    typeof tool.inputSchema !== 'object' ||
    Array.isArray(tool.inputSchema)
  ) {
    throw new TypeError('Module agent tool input schema must be an object')
  }
  if (typeof tool.handler !== 'function') {
    throw new TypeError('Module agent tool handler must be a function')
  }
  return Object.freeze({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    handler: tool.handler,
  })
}

function snapshotActivity(
  activity: NonNullable<YoloModuleAgentRequestV1['activity']>,
): NonNullable<YoloModuleAgentRequestV1['activity']> {
  if (!activity || typeof activity !== 'object') {
    throw new TypeError('Module agent activity must be an object')
  }
  if (typeof activity.title !== 'string' || !activity.title.trim()) {
    throw new TypeError(
      'Module agent activity title must be a non-empty string',
    )
  }
  if (activity.detail !== undefined && typeof activity.detail !== 'string') {
    throw new TypeError('Module agent activity detail must be a string')
  }
  return Object.freeze({
    title: activity.title,
    ...(activity.detail !== undefined ? { detail: activity.detail } : {}),
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
  moduleId: string,
  abortSignal: AbortSignal,
  toolContext: ModuleToolRuntimeContext,
): YoloAgentRunRequest {
  const capabilityProfile = resolveModuleCapabilityProfile(request.capability)
  return {
    ...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
    ...(request.messages ? { messages: request.messages.map(mapMessage) } : {}),
    ...(request.modelId !== undefined ? { modelId: request.modelId } : {}),
    mode: 'agent',
    yolo: true,
    systemPromptOverride: request.systemPrompt,
    tools: {
      allowedToolNames: [...capabilityProfile.allowedHostToolNames],
      ...(toolContext.inProcessServer
        ? { inProcessServer: toolContext.inProcessServer }
        : {}),
    },
    bashReadOnly: capabilityProfile.bashReadOnly,
    ...(request.workspaceScope
      ? {
          workspaceScope: {
            enabled: request.workspaceScope.enabled,
            include: [...request.workspaceScope.include],
            exclude: [...request.workspaceScope.exclude],
          },
        }
      : {}),
    ...(request.activity
      ? {
          activity: {
            kind: `module:${moduleId}`,
            title: request.activity.title,
            ...(request.activity.detail !== undefined
              ? { detail: request.activity.detail }
              : {}),
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

function mapEvent(
  event: YoloAgentEvent,
  moduleToolNameByFullName: ReadonlyMap<string, string>,
): YoloModuleAgentEventV1 | null {
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
        name: publicToolName(event.name, moduleToolNameByFullName),
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
        message: sanitizeErrorMessage(event.message, moduleToolNameByFullName),
      })
  }
}

function publicToolName(
  name: string,
  moduleToolNameByFullName: ReadonlyMap<string, string>,
): string {
  if (name === MODULE_CAPABILITY_TOOL_NAMES.bash) return 'vault.bash'
  if (name === MODULE_CAPABILITY_TOOL_NAMES.edit) return 'vault.edit'
  return moduleToolNameByFullName.get(name) ?? 'unknown'
}

/**
 * Per-run context for a module's own custom tools (`request.tools`): the
 * in-process server to hand to `agent.stream` (undefined when the request
 * declares no tools) and a full-name -> bare-name map used to make module
 * tools identifiable (not "unknown"/redacted) in events and error messages.
 */
type ModuleToolRuntimeContext = Readonly<{
  inProcessServer?: Readonly<{ name: string; server: InProcessToolServer }>
  publicNameByFullName: ReadonlyMap<string, string>
}>

function buildModuleToolRuntimeContext(
  request: YoloModuleAgentRequestV1,
  moduleId: string,
): ModuleToolRuntimeContext {
  const tools = request.tools
  if (!tools || tools.length === 0) {
    return Object.freeze({ publicNameByFullName: new Map() })
  }
  // Unique per call: guards against name collisions if the same module ever
  // has more than one tool-bearing run in flight (registerInProcessServer
  // throws on a duplicate server name).
  const serverName = `module-${moduleId}-${uuidv4()}`
  const publicNameByFullName = new Map(
    tools.map((tool) => [getToolName(serverName, tool.name), tool.name]),
  )
  return Object.freeze({
    inProcessServer: Object.freeze({
      name: serverName,
      server: createModuleToolInProcessServer(tools),
    }),
    publicNameByFullName,
  })
}

/**
 * Builds an `InProcessToolServer` that dispatches to `tools`' handlers,
 * serialized per server in arrival order (see the handler-serialization note
 * below). Exported so `moduleChatModeRegistry.ts` can build the same kind of
 * server for a chat mode's (longer-lived) tool set instead of re-implementing
 * the serial dispatch chain.
 */
export function createModuleToolInProcessServer(
  tools: readonly YoloModuleAgentToolV1[],
): InProcessToolServer {
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  // The agent loop dispatches a turn's tool calls concurrently, but module
  // tool handlers are run-scoped state mutators (append-to-file, buffer
  // pushes) that read-modify-write shared state. Serialize handler
  // invocations per server, in arrival order, so parallel emissions from a
  // single model turn cannot clobber each other.
  let chain: Promise<unknown> = Promise.resolve()
  return {
    listTools: (): McpTool[] =>
      tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as McpTool['inputSchema'],
      })),
    callTool: async ({ toolName, args }): Promise<ToolCallResponse> => {
      const tool = byName.get(toolName)
      if (!tool) {
        throw new Error(`Module tool "${toolName}" is not registered`)
      }
      const invoke = () => tool.handler(args)
      const pending = chain.then(invoke, invoke)
      chain = pending.then(
        () => undefined,
        () => undefined,
      )
      const result = await pending
      if (!result || typeof result.content !== 'string') {
        throw new TypeError(
          `Module tool "${toolName}" must resolve with a string content result`,
        )
      }
      return result.isError
        ? { status: ToolCallResponseStatus.Error, error: result.content }
        : {
            status: ToolCallResponseStatus.Success,
            data: { type: 'text', text: result.content },
          }
    },
  }
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

function sanitizeErrorMessage(
  message: string,
  moduleToolNameByFullName: ReadonlyMap<string, string>,
): string {
  return message.replace(
    /[A-Za-z0-9_-]+__[A-Za-z0-9_-]+/g,
    (match) => moduleToolNameByFullName.get(match) ?? 'internal tool',
  )
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
