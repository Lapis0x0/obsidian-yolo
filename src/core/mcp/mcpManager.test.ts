jest.mock('obsidian')

import { App, Platform, TFile } from 'obsidian'

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
          builtinToolOptions: {},
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

  it('executes built-in tools on mobile', async () => {
    const manager = createManager()

    await expect(
      manager.callTool({
        name: 'yolo_local__fs_read',
        args: {
          paths: ['note.md'],
          operation: {
            type: 'full',
          },
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
        operation: {
          type: 'replace',
          oldText: 'hello world',
          newText: 'updated',
        },
      },
      requireReview: true,
    })

    expect(manager.abortToolCall('tool-call-1')).toBe(true)
    await expect(pendingResult).resolves.toEqual({
      status: ToolCallResponseStatus.Aborted,
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
