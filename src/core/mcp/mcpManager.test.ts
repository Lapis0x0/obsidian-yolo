jest.mock('obsidian')

import { App, Platform, TFile } from 'obsidian'

import type { ApplyViewState } from '../../types/apply-view.types'
import { McpServerStatus } from '../../types/mcp.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

import { McpNotAvailableException } from './exception'
import { McpManager } from './mcpManager'

const OBSIDIAN_CONFIG_DIR = ['.', 'obsidian'].join('')

describe('McpManager mobile built-in tool behavior', () => {
  const originalIsDesktop = Platform.isDesktop

  beforeEach(() => {
    Platform.isDesktop = false
  })

  afterEach(() => {
    Platform.isDesktop = originalIsDesktop
  })

  function createManager(
    openApplyReview: (state: unknown) => Promise<boolean> = jest.fn(),
    builtinCapabilityOptions: Record<string, { disabled?: boolean }> = {},
  ) {
    const file = Object.assign(new TFile(), {
      path: 'note.md',
      extension: 'md',
      stat: { size: 20 },
    })

    return new McpManager({
      pluginId: 'test-plugin',
      app: {
        vault: {
          configDir: OBSIDIAN_CONFIG_DIR,
          getAbstractFileByPath: jest.fn().mockReturnValue(file),
          getFileByPath: jest.fn().mockReturnValue(file),
          read: jest.fn().mockResolvedValue('hello world'),
          readBinary: jest.fn().mockResolvedValue(new ArrayBuffer(0)),
          modify: jest.fn(),
          create: jest.fn(),
        },
      } as unknown as App,
      settings: {
        mcp: {
          servers: [],
          builtinCapabilityOptions,
        },
        webSearch: {
          providers: [],
          defaultProviderId: undefined,
          common: {
            resultSize: 8,
            searchTimeoutMs: 15000,
            scrapeTimeoutMs: 20000,
          },
        },
      } as never,
      openApplyReview,
      registerSettingsListener: () => () => {},
    })
  }

  it('lists built-in tools on mobile when requested', async () => {
    const manager = createManager()

    await expect(
      manager.listAvailableTools({ includeBuiltinTools: true }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'yolo_local__fs_write' }),
      ]),
    )
    await expect(
      manager.listAvailableTools({ includeBuiltinTools: false }),
    ).resolves.toEqual([])
  })

  it('lists web_scrape without a configured web search provider', async () => {
    const manager = createManager()

    const tools = await manager.listAvailableTools({
      includeBuiltinTools: true,
    })

    expect(tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'yolo_local__web_scrape' }),
      ]),
    )
    expect(tools).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'yolo_local__web_search' }),
      ]),
    )
  })

  it('disabling the file_editing capability hides all of its member tools', async () => {
    // D9 (docs/plans/2026-08-15-tool-registry/phase2-migration.md D9):
    // `builtinCapabilityOptions` is keyed by capability id, one entry per
    // capability — no more separate group-key-plus-member-keys aggregation.
    const manager = createManager(jest.fn(), {
      file_editing: { disabled: true },
    })

    const toolNames = (
      await manager.listAvailableTools({ includeBuiltinTools: true })
    ).map((tool) => tool.name)

    expect(toolNames).not.toContain('yolo_local__fs_edit')
    expect(toolNames).not.toContain('yolo_local__fs_write')
  })

  // D6b (docs/plans/2026-08-15-tool-registry/phase2-migration.md): proves
  // `fs_read`'s dynamic `modality` schema field — the one thing that forced
  // `BuiltinToolDefinition.getMcpTool` to be a function instead of a
  // constant (master.md §3.3) — actually reaches the model through the real
  // production call site (`McpManager.listAvailableTools` ->
  // `getLocalFileTools({ chatModelModalities })`,
  // `core/agent/llm-turn-executor.ts`'s own call passes
  // `this.input.model.modalities` the same way), not just the registry's
  // own unit tests.
  it('projects fs_read modality schema per chatModelModalities through listAvailableTools', async () => {
    const manager = createManager()

    const getFsReadModalityEnum = (
      tools: Awaited<ReturnType<typeof manager.listAvailableTools>>,
    ) => {
      const fsRead = tools.find((tool) => tool.name === 'yolo_local__fs_read')
      const properties = (
        fsRead?.inputSchema as { properties?: Record<string, unknown> }
      )?.properties
      return (properties?.modality as { enum?: string[] } | undefined)?.enum
    }

    const textOnly = await manager.listAvailableTools({
      includeBuiltinTools: true,
      chatModelModalities: [],
    })
    expect(getFsReadModalityEnum(textOnly)).toBeUndefined()

    const visionModel = await manager.listAvailableTools({
      includeBuiltinTools: true,
      chatModelModalities: ['vision'],
    })
    expect(getFsReadModalityEnum(visionModel)).toEqual(['text', 'image'])

    const pdfModel = await manager.listAvailableTools({
      includeBuiltinTools: true,
      chatModelModalities: ['pdf'],
    })
    expect(getFsReadModalityEnum(pdfModel)).toEqual(['text', 'pdf'])
  })

  it('executes built-in tools on mobile', async () => {
    const manager = createManager()

    await expect(
      manager.callTool({
        name: 'yolo_local__fs_write',
        args: {
          path: 'note.md',
          content: 'updated content',
        },
      }),
    ).resolves.toMatchObject({
      status: ToolCallResponseStatus.Success,
      data: expect.objectContaining({
        type: 'text',
      }),
    })
  })

  it('aborts active built-in tool calls on mobile', async () => {
    const manager = createManager(() => new Promise<boolean>(() => {}))

    const pendingResult = manager.callTool({
      name: 'yolo_local__fs_edit',
      id: 'tool-call-1',
      args: {
        path: 'note.md',
        oldText: 'hello world',
        newText: 'updated',
      },
      requireReview: true,
    })

    expect(manager.abortToolCall('tool-call-1')).toBe(true)
    await expect(pendingResult).resolves.toEqual({
      status: ToolCallResponseStatus.Aborted,
    })
  })

  it('preserves the rejection reason returned by a reviewed built-in tool', async () => {
    const manager = createManager(async (state) => {
      const review = state as ApplyViewState
      review.callbacks?.onComplete?.({
        finalContent: 'hello world',
        review: {
          totalChanges: 1,
          rejectedChanges: [
            {
              index: 1,
              originalText: 'hello world',
              proposedText: 'updated',
            },
          ],
        },
      })
      return true
    })

    await expect(
      manager.callTool({
        name: 'yolo_local__fs_edit',
        args: {
          path: 'note.md',
          oldText: 'hello world',
          newText: 'updated',
        },
        requireReview: true,
      }),
    ).resolves.toEqual({
      status: ToolCallResponseStatus.Rejected,
      reason:
        'Explicit user decision: this change was rejected in the review UI. This is not an edit or matching failure. Do not retry it with another locator or tool this turn; acknowledge the decision and wait for the user.',
    })
  })

  it('still rejects remote MCP tools on mobile', async () => {
    const manager = createManager()

    const result = await manager.callTool({
      name: 'demo__remote_tool',
      args: {},
    })

    expect(result).toEqual({
      status: ToolCallResponseStatus.Error,
      error: new McpNotAvailableException().message,
    })
  })
})

describe('McpManager connected tool catalog', () => {
  it('materializes the connect-time snapshot without another tools/list call', async () => {
    const originalIsDesktop = Platform.isDesktop
    Platform.isDesktop = true
    const manager = new McpManager({
      pluginId: 'test-plugin',
      app: {
        vault: { adapter: {}, configDir: OBSIDIAN_CONFIG_DIR },
      } as unknown as App,
      settings: {
        mcp: { servers: [], builtinCapabilityOptions: {} },
      } as never,
      openApplyReview: jest.fn(),
      registerSettingsListener: () => () => {},
    })
    Platform.isDesktop = originalIsDesktop
    const listTools = jest.fn()
    ;(manager as unknown as { servers: unknown[] }).servers = [
      {
        name: 'remote',
        status: McpServerStatus.Connected,
        client: { listTools },
        tools: [
          {
            name: 'search',
            description: 'Search',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
        config: { toolOptions: {} },
      },
    ]

    await expect(manager.listAvailableTools()).resolves.toEqual([
      expect.objectContaining({ name: 'remote__search' }),
    ])
    await expect(
      manager.listAvailableTools({ chatModelModalities: ['vision'] }),
    ).resolves.toEqual([expect.objectContaining({ name: 'remote__search' })])
    expect(listTools).not.toHaveBeenCalled()
  })
})
