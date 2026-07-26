jest.mock('obsidian')

import { App, Platform, TFile } from 'obsidian'

import type { ApplyViewState } from '../../types/apply-view.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

import { McpNotAvailableException } from './exception'
import { McpManager } from './mcpManager'

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
    builtinToolOptions: Record<string, { disabled?: boolean }> = {},
  ) {
    const file = Object.assign(new TFile(), {
      path: 'note.md',
      extension: 'md',
      stat: { size: 20 },
    })

    return new McpManager({
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(file),
          getFileByPath: jest.fn().mockReturnValue(file),
          read: jest.fn().mockResolvedValue('hello world'),
          readBinary: jest.fn().mockResolvedValue(new ArrayBuffer(0)),
        },
      } as unknown as App,
      settings: {
        mcp: {
          servers: [],
          builtinToolOptions,
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
        expect.objectContaining({ name: 'yolo_local__fs_read' }),
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

  it('keeps file editing tools separate from the file path operation group switch', async () => {
    const manager = createManager(jest.fn(), {
      fs_file_ops: { disabled: true },
      fs_edit: { disabled: false },
      fs_write: { disabled: false },
      fs_delete: { disabled: false },
    })

    const toolNames = (
      await manager.listAvailableTools({ includeBuiltinTools: true })
    ).map((tool) => tool.name)

    expect(toolNames).toContain('yolo_local__fs_edit')
    expect(toolNames).toContain('yolo_local__fs_write')
    expect(toolNames).not.toContain('yolo_local__fs_delete')
    expect(toolNames).toContain('yolo_local__fs_read')
  })

  it('keeps file path operation tools separate from the file editing group switch', async () => {
    const manager = createManager(jest.fn(), {
      fs_edit_ops: { disabled: true },
      fs_edit: { disabled: false },
      fs_write: { disabled: false },
      fs_delete: { disabled: false },
    })

    const toolNames = (
      await manager.listAvailableTools({ includeBuiltinTools: true })
    ).map((tool) => tool.name)

    expect(toolNames).not.toContain('yolo_local__fs_edit')
    expect(toolNames).not.toContain('yolo_local__fs_write')
    expect(toolNames).toContain('yolo_local__fs_delete')
    expect(toolNames).toContain('yolo_local__fs_read')
  })

  it('executes built-in tools on mobile', async () => {
    const manager = createManager()

    await expect(
      manager.callTool({
        name: 'yolo_local__fs_read',
        args: {
          paths: ['note.md'],
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
