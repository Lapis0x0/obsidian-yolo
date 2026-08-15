// Proves the ported `memory_add` / `memory_update` / `memory_delete`
// `execute()` implementations (src/core/tools/memory_*/definition.ts) behave
// identically to the still-live `case 'memory_add'` / ... branches of
// `callLocalFileTool` (src/core/mcp/localFileTools.ts) they were copied from
// — per Phase 1 D2's exit condition. Also exercises `executeBuiltinTool`
// (dispatcher.ts) end-to-end for the same tool, and its unknown-tool-name
// path, even though the dispatcher isn't wired into any live call path yet.

jest.mock('obsidian')

import { App, TFile, TFolder } from 'obsidian'

import type { YoloSettings } from '../../settings/schema/setting.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { callLocalFileTool } from '../mcp/localFileTools'

import { executeBuiltinTool } from './dispatcher'
import { memoryAddDefinition } from './memory_add/definition'
import { memoryDeleteDefinition } from './memory_delete/definition'
import { memoryUpdateDefinition } from './memory_update/definition'
import type { ToolContext } from './types'

const SETTINGS = {
  yolo: { baseDir: 'YOLO' },
  currentAssistantId: 'helper',
  assistants: [
    {
      id: 'helper',
      name: 'Helper Agent',
      systemPrompt: 'You are helper.',
    },
  ],
} as unknown as YoloSettings

/** Fresh, isolated mock vault — mirrors the fixture in localFileTools.test.ts. */
function createMockVaultApp(): { app: App; contents: Map<string, string> } {
  const entries = new Map<string, unknown>()
  const contents = new Map<string, string>()

  const app = {
    vault: {
      getAbstractFileByPath: jest
        .fn()
        .mockImplementation((path: string) => entries.get(path) ?? null),
      createFolder: jest.fn().mockImplementation(async (path: string) => {
        const folder = Object.assign(new TFolder(), { path, children: [] })
        entries.set(path, folder)
        return folder
      }),
      create: jest
        .fn()
        .mockImplementation(async (path: string, content: string) => {
          const file = Object.assign(new TFile(), {
            path,
            stat: { size: content.length },
          })
          entries.set(path, file)
          contents.set(path, content)
          return file
        }),
      read: jest
        .fn()
        .mockImplementation(
          async (file: TFile) => contents.get(file.path) ?? '',
        ),
      modify: jest
        .fn()
        .mockImplementation(async (file: TFile, content: string) => {
          contents.set(file.path, content)
          ;(file as { stat?: { size?: number } }).stat = {
            size: content.length,
          }
        }),
    },
  } as unknown as App

  return { app, contents }
}

function makeCtx(app: App): ToolContext {
  return { app, settings: SETTINGS }
}

describe('memory_add execute() vs callLocalFileTool', () => {
  it('single entry: same result, same vault content', async () => {
    const oldVault = createMockVaultApp()
    const newVault = createMockVaultApp()
    const args = { content: '用户希望回答保持简洁', category: 'preferences' }

    const oldResult = await callLocalFileTool({
      app: oldVault.app,
      settings: SETTINGS,
      toolName: 'memory_add',
      args,
    })
    const newResult = await memoryAddDefinition.execute(
      args,
      makeCtx(newVault.app),
    )

    expect(newResult).toEqual(oldResult)
    expect(Object.fromEntries(newVault.contents)).toEqual(
      Object.fromEntries(oldVault.contents),
    )
  })

  it('batch items with a partial failure: same result, same vault content', async () => {
    const oldVault = createMockVaultApp()
    const newVault = createMockVaultApp()
    const args = {
      items: [
        { content: '批量记录 1', category: 'other' },
        { content: '   ', category: 'other' },
        { content: '批量记录 2', category: 'other' },
      ],
    }

    const oldResult = await callLocalFileTool({
      app: oldVault.app,
      settings: SETTINGS,
      toolName: 'memory_add',
      args,
    })
    const newResult = await memoryAddDefinition.execute(
      args,
      makeCtx(newVault.app),
    )

    expect(newResult).toEqual(oldResult)
    expect(Object.fromEntries(newVault.contents)).toEqual(
      Object.fromEntries(oldVault.contents),
    )
  })

  it('neither content nor items: old wraps to an Error result, new throws for the dispatcher to normalize', async () => {
    const oldVault = createMockVaultApp()
    const newVault = createMockVaultApp()

    const oldResult = await callLocalFileTool({
      app: oldVault.app,
      settings: SETTINGS,
      toolName: 'memory_add',
      args: {},
    })
    expect(oldResult).toEqual({
      status: ToolCallResponseStatus.Error,
      error: 'content or items is required.',
    })

    await expect(
      memoryAddDefinition.execute({}, makeCtx(newVault.app)),
    ).rejects.toThrow('content or items is required.')
  })
})

describe('memory_update execute() vs callLocalFileTool', () => {
  it('updates an existing entry identically', async () => {
    const oldVault = createMockVaultApp()
    const newVault = createMockVaultApp()
    const seed = { content: '用户希望回答保持简洁', category: 'preferences' }

    await callLocalFileTool({
      app: oldVault.app,
      settings: SETTINGS,
      toolName: 'memory_add',
      args: seed,
    })
    await memoryAddDefinition.execute(seed, makeCtx(newVault.app))

    const updateArgs = {
      id: 'Preference_1',
      new_content: '用户希望回答保持简洁并直接',
    }
    const oldResult = await callLocalFileTool({
      app: oldVault.app,
      settings: SETTINGS,
      toolName: 'memory_update',
      args: updateArgs,
    })
    const newResult = await memoryUpdateDefinition.execute(
      updateArgs,
      makeCtx(newVault.app),
    )

    expect(newResult).toEqual(oldResult)
    expect(Object.fromEntries(newVault.contents)).toEqual(
      Object.fromEntries(oldVault.contents),
    )
  })
})

describe('memory_delete execute() vs callLocalFileTool', () => {
  it('single id: same result, same vault content', async () => {
    const oldVault = createMockVaultApp()
    const newVault = createMockVaultApp()
    const seed = { content: '用户希望回答保持简洁', category: 'preferences' }

    await callLocalFileTool({
      app: oldVault.app,
      settings: SETTINGS,
      toolName: 'memory_add',
      args: seed,
    })
    await memoryAddDefinition.execute(seed, makeCtx(newVault.app))

    const deleteArgs = { id: 'Preference_1' }
    const oldResult = await callLocalFileTool({
      app: oldVault.app,
      settings: SETTINGS,
      toolName: 'memory_delete',
      args: deleteArgs,
    })
    const newResult = await memoryDeleteDefinition.execute(
      deleteArgs,
      makeCtx(newVault.app),
    )

    expect(newResult).toEqual(oldResult)
    expect(Object.fromEntries(newVault.contents)).toEqual(
      Object.fromEntries(oldVault.contents),
    )
  })

  it('batch ids with a partial failure: same result, same vault content', async () => {
    const oldVault = createMockVaultApp()
    const newVault = createMockVaultApp()
    const seedItems = {
      items: [
        { content: '批量记录 1', category: 'other' },
        { content: '批量记录 2', category: 'other' },
      ],
    }

    await callLocalFileTool({
      app: oldVault.app,
      settings: SETTINGS,
      toolName: 'memory_add',
      args: seedItems,
    })
    await memoryAddDefinition.execute(seedItems, makeCtx(newVault.app))

    const deleteArgs = { ids: ['Memory_1', 'NotExist_404', 'Memory_2'] }
    const oldResult = await callLocalFileTool({
      app: oldVault.app,
      settings: SETTINGS,
      toolName: 'memory_delete',
      args: deleteArgs,
    })
    const newResult = await memoryDeleteDefinition.execute(
      deleteArgs,
      makeCtx(newVault.app),
    )

    expect(newResult).toEqual(oldResult)
    expect(Object.fromEntries(newVault.contents)).toEqual(
      Object.fromEntries(oldVault.contents),
    )
  })
})

describe('executeBuiltinTool (dispatcher) vs callLocalFileTool end-to-end', () => {
  it('matches for a successful memory_add call', async () => {
    const oldVault = createMockVaultApp()
    const newVault = createMockVaultApp()
    const args = { content: 'dispatcher parity check' }

    const oldResult = await callLocalFileTool({
      app: oldVault.app,
      settings: SETTINGS,
      toolName: 'memory_add',
      args,
    })
    const newResult = await executeBuiltinTool(
      'memory_add',
      args,
      makeCtx(newVault.app),
    )

    expect(newResult).toEqual(oldResult)
  })

  it('matches the old outer-catch Error result for a validation failure', async () => {
    const oldVault = createMockVaultApp()
    const newVault = createMockVaultApp()

    const oldResult = await callLocalFileTool({
      app: oldVault.app,
      settings: SETTINGS,
      toolName: 'memory_add',
      args: {},
    })
    const newResult = await executeBuiltinTool(
      'memory_add',
      {},
      makeCtx(newVault.app),
    )

    expect(newResult).toEqual(oldResult)
  })

  it('matches the old default-case Error result for an unknown tool name', async () => {
    const oldVault = createMockVaultApp()
    const newVault = createMockVaultApp()

    const oldResult = await callLocalFileTool({
      app: oldVault.app,
      settings: SETTINGS,
      toolName: 'not_a_real_tool',
      args: {},
    })
    const newResult = await executeBuiltinTool(
      'not_a_real_tool',
      {},
      makeCtx(newVault.app),
    )

    expect(newResult).toEqual(oldResult)
  })
})
