import { App, normalizePath } from 'obsidian'
import { v4 as uuidv4 } from 'uuid'

import { ChatManager } from '../../database/json/chat/ChatManager'
import type { YoloSettings } from '../../settings/schema/setting.types'
import type { ChatMessage } from '../../types/chat'
import {
  type YoloAgentRunRequest,
  resolveAgentApiRunInput,
} from '../agent/agent-api'
import { DEFAULT_ASSISTANT_ID } from '../agent/default-assistant'
import {
  type AgentConversationState,
  type AgentService,
  buildAgentConversationRunSummary,
} from '../agent/service'
import { ensureJsonDbRootDir } from '../paths/yoloManagedData'
import { getYoloJsonDbRootDir } from '../paths/yoloPaths'

import type { McpManager } from './mcpManager'

const TASK_STORE_FILE_NAME = 'external-agent-tasks.json'
const TASK_STORE_VERSION = 1
const MAX_CONCURRENT_TASKS = 4
const MAX_PROMPT_LENGTH = 100_000

export type ExternalAgentTaskStatus =
  | 'running'
  | 'waiting_for_user'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type ExternalAgentTask = {
  taskId: string
  conversationId: string
  sourceUserMessageId: string
  assistantId: string
  status: ExternalAgentTaskStatus
  createdAt: number
  updatedAt: number
  revision: number
  result?: string
  error?: string
}

type ExternalAgentTaskFile = {
  version: 1
  tasks: Record<string, ExternalAgentTask>
}

type ExternalAgentTaskRuntime = {
  controller: AbortController
  unsubscribe: () => void
  updateQueue: Promise<void>
  lastStatus: ExternalAgentTaskStatus
  cancelRequested: boolean
  settled: Promise<void>
  resolveSettled: () => void
}

type ExternalAgentTaskServiceOptions = {
  app: App
  getSettings: () => YoloSettings
  getAgentService: () => Promise<AgentService>
  getMcpManager: () => Promise<McpManager>
  openConversation: (conversationId: string) => Promise<void>
}

const EMPTY_TASK_FILE: ExternalAgentTaskFile = {
  version: TASK_STORE_VERSION,
  tasks: {},
}

const isActiveTaskStatus = (status: ExternalAgentTaskStatus): boolean =>
  status === 'running' || status === 'waiting_for_user'

const isTerminalTaskStatus = (status: ExternalAgentTaskStatus): boolean =>
  !isActiveTaskStatus(status)

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const buildConversationTitle = (prompt: string): string => {
  const firstLine = prompt.split(/\r?\n/, 1)[0].replace(/\s+/g, ' ').trim()
  if (!firstLine) return 'External agent task'
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine
}

const findTaskResult = (
  messages: ChatMessage[],
  sourceUserMessageId: string,
): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (
      message.role === 'assistant' &&
      message.metadata?.sourceUserMessageId === sourceUserMessageId
    ) {
      return message.content
    }
  }

  const userIndex = messages.findIndex(
    (message) => message.role === 'user' && message.id === sourceUserMessageId,
  )
  for (let index = messages.length - 1; index > userIndex; index -= 1) {
    const message = messages[index]
    if (message.role === 'assistant') {
      return message.content
    }
  }
  return ''
}

export class ExternalAgentTaskStore {
  private writeQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly app: App,
    private readonly getSettings: () => YoloSettings,
  ) {}

  async initialize(): Promise<void> {
    await this.enqueue(async () => {
      const path = await this.getFilePath()
      if (!(await this.app.vault.adapter.exists(path))) {
        return
      }
      const file = await this.read()
      const now = Date.now()
      let changed = false
      for (const task of Object.values(file.tasks)) {
        if (!isActiveTaskStatus(task.status)) continue
        task.status = 'interrupted'
        task.updatedAt = now
        task.revision += 1
        task.error = 'Obsidian or the YOLO plugin restarted before completion.'
        changed = true
      }
      if (changed) {
        await this.write(file)
      }
    })
  }

  async create(task: ExternalAgentTask): Promise<void> {
    await this.mutate((file) => {
      if (file.tasks[task.taskId]) {
        throw new Error(`Task already exists: ${task.taskId}`)
      }
      file.tasks[task.taskId] = task
    })
  }

  async get(taskId: string): Promise<ExternalAgentTask | null> {
    return this.enqueue(async () => {
      const task = (await this.read()).tasks[taskId]
      return task ? { ...task } : null
    })
  }

  async list(): Promise<ExternalAgentTask[]> {
    return this.enqueue(async () =>
      Object.values((await this.read()).tasks).map((task) => ({ ...task })),
    )
  }

  async update(
    taskId: string,
    updates: Partial<Pick<ExternalAgentTask, 'status' | 'result' | 'error'>>,
  ): Promise<ExternalAgentTask> {
    let updated: ExternalAgentTask | null = null
    await this.mutate((file) => {
      const current = file.tasks[taskId]
      if (!current) {
        throw new Error(`Unknown task: ${taskId}`)
      }
      updated = {
        ...current,
        ...updates,
        updatedAt: Date.now(),
        revision: current.revision + 1,
      }
      file.tasks[taskId] = updated
    })
    return { ...(updated as unknown as ExternalAgentTask) }
  }

  private async mutate(
    mutation: (file: ExternalAgentTaskFile) => void,
  ): Promise<void> {
    await this.enqueue(async () => {
      const file = await this.read()
      mutation(file)
      await this.write(file)
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(operation, operation)
    this.writeQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private async getFilePath(): Promise<string> {
    const settings = this.getSettings()
    const root = await ensureJsonDbRootDir(this.app, settings)
    if (!(await this.app.vault.adapter.exists(root))) {
      await this.app.vault.adapter.mkdir(root)
    }
    return normalizePath(
      `${root || getYoloJsonDbRootDir(settings)}/${TASK_STORE_FILE_NAME}`,
    )
  }

  private async read(): Promise<ExternalAgentTaskFile> {
    const path = await this.getFilePath()
    if (!(await this.app.vault.adapter.exists(path))) {
      return { ...EMPTY_TASK_FILE, tasks: {} }
    }
    try {
      const parsed = JSON.parse(
        await this.app.vault.adapter.read(path),
      ) as Partial<ExternalAgentTaskFile>
      return {
        version: TASK_STORE_VERSION,
        tasks:
          parsed.tasks && typeof parsed.tasks === 'object' ? parsed.tasks : {},
      }
    } catch (error) {
      console.error('[YOLO] Failed to read external agent task store', error)
      throw error
    }
  }

  private async write(file: ExternalAgentTaskFile): Promise<void> {
    await this.app.vault.adapter.write(
      await this.getFilePath(),
      JSON.stringify(file, null, 2),
    )
  }
}

export class ExternalAgentTaskService {
  private readonly store: ExternalAgentTaskStore
  private readonly runtimes = new Map<string, ExternalAgentTaskRuntime>()
  private shuttingDown = false

  constructor(private readonly options: ExternalAgentTaskServiceOptions) {
    this.store = new ExternalAgentTaskStore(options.app, options.getSettings)
  }

  async initialize(): Promise<void> {
    await this.store.initialize()
  }

  async start({
    prompt,
    assistantId,
  }: {
    prompt: string
    assistantId?: string
  }): Promise<ExternalAgentTask> {
    const normalizedPrompt = prompt.trim()
    if (!normalizedPrompt) {
      throw new Error('prompt is required.')
    }
    if (normalizedPrompt.length > MAX_PROMPT_LENGTH) {
      throw new Error(`prompt exceeds ${MAX_PROMPT_LENGTH} characters.`)
    }
    if (this.runtimes.size >= MAX_CONCURRENT_TASKS) {
      throw new Error(
        `At most ${MAX_CONCURRENT_TASKS} external agent tasks may run concurrently.`,
      )
    }

    const settings = this.options.getSettings()
    const resolvedAssistantId =
      assistantId ?? settings.currentAssistantId ?? DEFAULT_ASSISTANT_ID
    if (
      !settings.assistants.some(
        (assistant) => assistant.id === resolvedAssistantId,
      )
    ) {
      throw new Error(`Unknown assistantId: ${resolvedAssistantId}`)
    }

    const conversationId = uuidv4()
    const controller = new AbortController()
    const agentService = await this.options.getAgentService()
    const request: YoloAgentRunRequest = {
      prompt: normalizedPrompt,
      assistantId: resolvedAssistantId,
      mode: 'agent',
    }
    const resolved = await resolveAgentApiRunInput({
      request,
      conversationId,
      abortSignal: controller.signal,
      app: this.options.app,
      settings,
      agentService,
      mcpManager: await this.options.getMcpManager(),
    })

    agentService.replaceConversationMessages(
      conversationId,
      resolved.input.messages,
      [],
      { persistState: true },
    )
    await agentService.flushConversationPersistence(conversationId)
    await new ChatManager(this.options.app, settings).updateChat(
      conversationId,
      {
        title: buildConversationTitle(normalizedPrompt),
        assistantId: resolvedAssistantId,
      },
    )

    const now = Date.now()
    const task: ExternalAgentTask = {
      taskId: conversationId,
      conversationId,
      sourceUserMessageId: resolved.sourceUserMessageId,
      assistantId: resolvedAssistantId,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      revision: 1,
    }
    await this.store.create(task)

    let resolveSettled: () => void = () => undefined
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve
    })
    const runtime: ExternalAgentTaskRuntime = {
      controller,
      unsubscribe: () => undefined,
      updateQueue: Promise.resolve(),
      lastStatus: 'running',
      cancelRequested: false,
      settled,
      resolveSettled,
    }
    runtime.unsubscribe = agentService.subscribe(
      conversationId,
      (state) => this.enqueueStateUpdate(task, runtime, state),
      { emitCurrent: false },
    )
    this.runtimes.set(task.taskId, runtime)

    void agentService
      .run({
        conversationId,
        persistState: true,
        loopConfig: resolved.loopConfig,
        input: resolved.input,
        activity: resolved.activity,
      })
      .catch((error) => {
        void this.failTask(task.taskId, runtime, toErrorMessage(error))
      })

    return task
  }

  get(taskId: string): Promise<ExternalAgentTask | null> {
    return this.store.get(taskId)
  }

  async cancel(taskId: string): Promise<ExternalAgentTask> {
    const task = await this.store.get(taskId)
    if (!task) {
      throw new Error(`Unknown taskId: ${taskId}`)
    }
    if (isTerminalTaskStatus(task.status)) {
      return task
    }

    const runtime = this.runtimes.get(taskId)
    if (!runtime) {
      return this.store.update(taskId, {
        status: 'cancelled',
        error: 'Task was cancelled.',
      })
    }
    runtime.cancelRequested = true
    runtime.controller.abort()
    ;(await this.options.getAgentService()).abortConversation(
      task.conversationId,
    )
    await Promise.race([
      runtime.settled,
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ])
    return (await this.store.get(taskId)) ?? task
  }

  async close(): Promise<void> {
    this.beginShutdown()
    const active = [...this.runtimes.entries()]
    await Promise.all(
      active.map(async ([taskId, runtime]) => {
        runtime.controller.abort()
        runtime.unsubscribe()
        await runtime.updateQueue.catch(() => undefined)
        await this.store.update(taskId, {
          status: 'interrupted',
          error: 'Obsidian or the YOLO plugin stopped before completion.',
        })
        runtime.resolveSettled()
      }),
    )
    this.runtimes.clear()
  }

  beginShutdown(): void {
    this.shuttingDown = true
  }

  private enqueueStateUpdate(
    task: ExternalAgentTask,
    runtime: ExternalAgentTaskRuntime,
    state: AgentConversationState,
  ): void {
    runtime.updateQueue = runtime.updateQueue
      .then(() => this.reconcileState(task, runtime, state))
      .catch((error) => {
        console.error('[YOLO] Failed to update external agent task', error)
      })
  }

  private async reconcileState(
    task: ExternalAgentTask,
    runtime: ExternalAgentTaskRuntime,
    state: AgentConversationState,
  ): Promise<void> {
    const summary = buildAgentConversationRunSummary(state)
    let status: ExternalAgentTaskStatus | null = null
    if (summary.isWaitingApproval) {
      status = 'waiting_for_user'
    } else if (summary.isActive) {
      status = 'running'
    } else if (state.status === 'completed') {
      status = 'completed'
    } else if (state.status === 'error') {
      status = 'failed'
    } else if (state.status === 'aborted') {
      status = this.shuttingDown ? 'interrupted' : 'cancelled'
    }
    if (!status || status === runtime.lastStatus) {
      return
    }

    const agentService = await this.options.getAgentService()
    await agentService.flushConversationPersistence(task.conversationId)
    runtime.lastStatus = status

    if (status === 'waiting_for_user') {
      await this.store.update(task.taskId, { status })
      await this.options.openConversation(task.conversationId)
      return
    }
    if (status === 'running') {
      await this.store.update(task.taskId, {
        status,
        result: undefined,
        error: undefined,
      })
      return
    }

    const result = findTaskResult(state.messages, task.sourceUserMessageId)
    await this.store.update(task.taskId, {
      status,
      ...(status === 'completed' ? { result, error: undefined } : {}),
      ...(status === 'failed'
        ? { error: state.errorMessage ?? 'Agent task failed.' }
        : {}),
      ...(status === 'cancelled' ? { error: 'Task was cancelled.' } : {}),
      ...(status === 'interrupted'
        ? { error: 'Obsidian or the YOLO plugin stopped before completion.' }
        : {}),
    })
    this.releaseRuntime(task.taskId, runtime)
  }

  private async failTask(
    taskId: string,
    runtime: ExternalAgentTaskRuntime,
    error: string,
  ): Promise<void> {
    if (!this.runtimes.has(taskId)) return
    await this.store.update(taskId, { status: 'failed', error })
    this.releaseRuntime(taskId, runtime)
  }

  private releaseRuntime(
    taskId: string,
    runtime: ExternalAgentTaskRuntime,
  ): void {
    runtime.unsubscribe()
    runtime.controller.abort()
    this.runtimes.delete(taskId)
    runtime.resolveSettled()
  }
}
