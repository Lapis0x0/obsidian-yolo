jest.mock('obsidian')

import { App, TFile, TFolder } from 'obsidian'

import {
  getMemoryPromptContext,
  memoryAdd,
  memoryDelete,
  memoryUpdate,
} from './memoryManager'

type MockVault = {
  app: App
  readByPath: (path: string) => string
}

const createMockVaultApp = (): MockVault => {
  const entries = new Map<string, unknown>()
  const contents = new Map<string, string>()

  const vault = {
    getAbstractFileByPath: jest.fn((path: string) => entries.get(path) ?? null),
    createFolder: jest.fn(async (path: string) => {
      const folder = Object.assign(new TFolder(), {
        path,
        children: [],
      })
      entries.set(path, folder)
      return folder
    }),
    create: jest.fn(async (path: string, content: string) => {
      const file = Object.assign(new TFile(), {
        path,
        stat: { size: content.length },
      })
      entries.set(path, file)
      contents.set(path, content)
      return file
    }),
    read: jest.fn(async (file: TFile) => contents.get(file.path) ?? ''),
    modify: jest.fn(async (file: TFile, content: string) => {
      contents.set(file.path, content)
      ;(file as { stat?: { size?: number } }).stat = {
        size: content.length,
      }
    }),
  }

  return {
    app: {
      vault,
    } as unknown as App,
    readByPath: (path: string) => contents.get(path) ?? '',
  }
}

describe('memoryManager', () => {
  it('falls back assistant scope to global when assistant instructions are empty', async () => {
    const { app, readByPath } = createMockVaultApp()
    const settings = {
      yolo: { baseDir: 'YOLO' },
      currentAssistantId: '__default_agent__',
      assistants: [
        {
          id: '__default_agent__',
          systemPrompt: '',
        },
      ],
    }

    const result = await memoryAdd({
      app,
      settings,
      content: '用户不喜欢结尾反问',
    })

    expect(result.scope).toBe('global')
    expect(result.filePath).toBe('YOLO/memory/global.md')
    expect(readByPath(result.filePath)).toContain(
      '- Memory_1: 用户不喜欢结尾反问',
    )
  })

  it('keeps section ids monotonic after delete', async () => {
    const { app, readByPath } = createMockVaultApp()
    const settings = {
      yolo: { baseDir: 'YOLO' },
      currentAssistantId: 'dev/1',
      assistants: [
        {
          id: 'dev/1',
          systemPrompt: 'You are my engineering assistant.',
        },
      ],
    }

    const first = await memoryAdd({
      app,
      settings,
      content: '用户叫 Alice',
      category: 'profile',
    })
    const second = await memoryAdd({
      app,
      settings,
      content: '用户在做 YOLO 插件',
      category: 'profile',
    })
    await memoryDelete({
      app,
      settings,
      id: first.id,
    })

    const third = await memoryAdd({
      app,
      settings,
      content: '用户习惯深夜开发',
      category: 'profile',
    })

    expect(first.id).toBe('Profile_1')
    expect(second.id).toBe('Profile_2')
    expect(third.id).toBe('Profile_3')
    expect(first.scope).toBe('assistant')
    expect(first.filePath).toBe('YOLO/memory/assistant-dev_1.md')

    const fileContent = readByPath(first.filePath)
    expect(fileContent).not.toContain('Profile_1')
    expect(fileContent).toContain('- Profile_2: 用户在做 YOLO 插件')
    expect(fileContent).toContain('- Profile_3: 用户习惯深夜开发')
  })

  it('reads global and assistant prompt context', async () => {
    const { app } = createMockVaultApp()
    const settings = {
      yolo: { baseDir: 'YOLO' },
      currentAssistantId: 'helper',
      assistants: [
        {
          id: 'helper',
          systemPrompt: 'You are helper.',
        },
      ],
    }

    await memoryAdd({
      app,
      settings,
      content: '用户希望回答简洁',
      category: 'preferences',
      scope: 'global',
    })
    const assistantMemory = await memoryAdd({
      app,
      settings,
      content: '当前在实现记忆工具',
      category: 'other',
      scope: 'assistant',
    })
    await memoryUpdate({
      app,
      settings,
      id: assistantMemory.id,
      newContent: '当前在实现 YOLO 记忆机制',
      scope: 'assistant',
    })

    const context = await getMemoryPromptContext({
      app,
      settings,
      assistantId: 'helper',
    })

    expect(context.global).toContain('Preference_1')
    expect(context.assistant).toContain('Memory_1: 当前在实现 YOLO 记忆机制')
  })
})
