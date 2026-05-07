jest.mock('obsidian', () =>
  jest.requireActual('../../runtime/web/obsidianCompat'),
)

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
    expect(readByPath(result.filePath)).not.toContain(
      'Long-term characteristics',
    )
    expect(readByPath(result.filePath)).not.toContain('behavioral patterns')
    expect(readByPath(result.filePath)).not.toContain('Contextual facts')
  })

  it('keeps section ids monotonic after delete', async () => {
    const { app, readByPath } = createMockVaultApp()
    const settings = {
      yolo: { baseDir: 'YOLO' },
      currentAssistantId: 'dev/1',
      assistants: [
        {
          id: 'dev/1',
          name: 'Dev Helper',
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
    expect(first.filePath).toBe('YOLO/memory/Dev Helper.md')

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
          name: '助手A',
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

  it('parses section heading aliases and preserves custom text', async () => {
    const { app, readByPath } = createMockVaultApp()
    const settings = {
      yolo: { baseDir: 'YOLO' },
    }

    const seedContent = [
      '## user profile',
      '> keep this note',
      '',
      '* Profile_4：已有记录',
      '',
      '## Preferences',
      '- Preference_1: existing pref',
      '',
      '## Other Memory',
      '- Memory_2: other item',
      '',
      'Some custom footer text.',
      '',
    ].join('\n')

    await (
      app as unknown as {
        vault: { createFolder: (path: string) => Promise<unknown> }
      }
    ).vault.createFolder('YOLO')
    await (
      app as unknown as {
        vault: { createFolder: (path: string) => Promise<unknown> }
      }
    ).vault.createFolder('YOLO/memory')
    await (
      app as unknown as {
        vault: { create: (path: string, content: string) => Promise<unknown> }
      }
    ).vault.create('YOLO/memory/global.md', seedContent)

    const result = await memoryAdd({
      app,
      settings,
      content: '新增档案',
      category: 'profile',
      scope: 'global',
    })

    expect(result.id).toBe('Profile_5')
    const content = readByPath('YOLO/memory/global.md')
    expect(content).toContain('> keep this note')
    expect(content).toContain('Some custom footer text.')
    expect(content).toContain('- Profile_5: 新增档案')
  })

  it('throws when duplicated id is found in memory file', async () => {
    const { app } = createMockVaultApp()
    const settings = {
      yolo: { baseDir: 'YOLO' },
    }

    const duplicatedContent = [
      '# User Profile',
      '- Profile_1: A',
      '',
      '# Preferences',
      '- Profile_1: B',
      '',
      '# Other Memory',
      '',
    ].join('\n')

    await (
      app as unknown as {
        vault: { createFolder: (path: string) => Promise<unknown> }
      }
    ).vault.createFolder('YOLO')
    await (
      app as unknown as {
        vault: { createFolder: (path: string) => Promise<unknown> }
      }
    ).vault.createFolder('YOLO/memory')
    await (
      app as unknown as {
        vault: { create: (path: string, content: string) => Promise<unknown> }
      }
    ).vault.create('YOLO/memory/global.md', duplicatedContent)

    await expect(
      memoryUpdate({
        app,
        settings,
        id: 'Profile_1',
        newContent: 'C',
        scope: 'global',
      }),
    ).rejects.toThrow('Memory id duplicated: Profile_1')
  })

  it('uses assistant name and appends index for duplicate names', async () => {
    const { app } = createMockVaultApp()
    const settings = {
      yolo: { baseDir: 'YOLO' },
      currentAssistantId: 'helper-2',
      assistants: [
        {
          id: 'helper-1',
          name: '测试 Agent',
          systemPrompt: 'A1',
        },
        {
          id: 'helper-2',
          name: '测试 Agent',
          systemPrompt: 'A2',
        },
      ],
    }

    const addResult = await memoryAdd({
      app,
      settings,
      content: 'test memory',
      scope: 'assistant',
    })
    expect(addResult.filePath).toBe('YOLO/memory/测试 Agent (2).md')

    const context = await getMemoryPromptContext({
      app,
      settings,
      assistantId: 'helper-2',
    })
    expect(context.assistant).toContain('Memory_1: test memory')
  })
})
