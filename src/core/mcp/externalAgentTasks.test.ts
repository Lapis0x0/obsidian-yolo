import type { App } from 'obsidian'

import { ChatManager } from '../../database/json/chat/ChatManager'
import type { YoloSettings } from '../../settings/schema/setting.types'
import * as agentApi from '../agent/agent-api'
import type { AgentService } from '../agent/service'

import {
  type ExternalAgentTask,
  ExternalAgentTaskService,
  ExternalAgentTaskStore,
} from './externalAgentTasks'
import type { McpManager } from './mcpManager'

const TASK_PATH = 'YOLO/.yolo_json_db/external-agent-tasks.json'

const createHarness = () => {
  const files = new Map<string, string>()
  const folders = new Set<string>()
  const adapter = {
    exists: jest.fn(
      async (path: string) => files.has(path) || folders.has(path),
    ),
    mkdir: jest.fn(async (path: string) => {
      folders.add(path)
    }),
    read: jest.fn(async (path: string) => {
      const content = files.get(path)
      if (content === undefined) throw new Error(`Missing file: ${path}`)
      return content
    }),
    write: jest.fn(async (path: string, content: string) => {
      files.set(path, content)
    }),
  }
  const app = { vault: { adapter } } as unknown as App
  const settings = { yolo: { baseDir: 'YOLO' } } as YoloSettings
  const store = new ExternalAgentTaskStore(app, () => settings)
  return { adapter, app, files, settings, store }
}

const makeTask = (
  status: ExternalAgentTask['status'] = 'running',
): ExternalAgentTask => ({
  taskId: 'task-1',
  conversationId: 'task-1',
  sourceUserMessageId: 'user-1',
  assistantId: 'assistant-1',
  status,
  createdAt: 1,
  updatedAt: 1,
  revision: 1,
})

describe('ExternalAgentTaskStore', () => {
  it('does not create an empty task file on startup', async () => {
    const { files, store } = createHarness()

    await store.initialize()

    expect(files.has(TASK_PATH)).toBe(false)
  })

  it('persists task creation and monotonic updates', async () => {
    const { store } = createHarness()

    await store.create(makeTask())
    const updated = await store.update('task-1', {
      status: 'completed',
      result: 'done',
    })

    expect(updated).toMatchObject({
      status: 'completed',
      result: 'done',
      revision: 2,
    })
    await expect(store.get('task-1')).resolves.toMatchObject(updated)
  })

  it('marks unfinished tasks interrupted on startup', async () => {
    const { store } = createHarness()
    await store.create(makeTask('waiting_for_user'))

    await store.initialize()

    await expect(store.get('task-1')).resolves.toMatchObject({
      status: 'interrupted',
      revision: 2,
      error: expect.stringContaining('restarted'),
    })
  })

  it('does not overwrite a corrupt task store', async () => {
    const { files, store } = createHarness()
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation()
    files.set(TASK_PATH, '{broken')

    try {
      await expect(store.initialize()).rejects.toThrow()
      expect(files.get(TASK_PATH)).toBe('{broken')
    } finally {
      consoleSpy.mockRestore()
    }
  })
})

describe('ExternalAgentTaskService', () => {
  it('creates the conversation with an immutable external-agent origin', async () => {
    const { app, settings } = createHarness()
    settings.assistants = [
      {
        id: 'assistant-1',
        name: 'Assistant 1',
      },
    ] as YoloSettings['assistants']
    settings.currentAssistantId = 'assistant-1'
    const createChatSpy = jest
      .spyOn(ChatManager.prototype, 'createChat')
      .mockResolvedValue({} as never)
    const resolveSpy = jest
      .spyOn(agentApi, 'resolveAgentApiRunInput')
      .mockResolvedValue({
        input: { messages: [] },
        sourceUserMessageId: 'user-1',
        loopConfig: {},
        activity: {},
      } as never)
    const flushConversationPersistence = jest.fn().mockResolvedValue(undefined)
    const agentService = {
      replaceConversationMessages: jest.fn(),
      flushConversationPersistence,
      subscribe: jest.fn().mockReturnValue(jest.fn()),
      run: jest.fn().mockResolvedValue(undefined),
    } as unknown as AgentService
    const service = new ExternalAgentTaskService({
      app,
      getSettings: () => settings,
      getAgentService: async () => agentService,
      getMcpManager: async () => ({}) as McpManager,
      openConversation: async () => undefined,
    })

    try {
      await service.start({ prompt: 'Summarize the project' })

      expect(createChatSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Summarize the project',
          assistantId: 'assistant-1',
          origin: 'external-agent',
        }),
      )
      expect(flushConversationPersistence).toHaveBeenCalled()
    } finally {
      createChatSpy.mockRestore()
      resolveSpy.mockRestore()
    }
  })
})
