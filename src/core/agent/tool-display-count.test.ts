import type { Assistant } from '../../types/assistant.types'
import type { McpTool } from '../../types/mcp.types'

import { countEnabledVisibleAssistantTools } from './tool-display-count'

const tool = (name: string): McpTool => ({
  name,
  description: name,
  inputSchema: { type: 'object' },
})

const assistantWithTools = (
  enabledToolNames: string[],
  includeBuiltinTools = true,
): Pick<
  Assistant,
  'toolPreferences' | 'enabledToolNames' | 'includeBuiltinTools'
> => ({
  enabledToolNames,
  toolPreferences: {},
  includeBuiltinTools,
})

describe('countEnabledVisibleAssistantTools', () => {
  it('excludes saved tools that are not currently available', () => {
    const assistant = assistantWithTools([
      'yolo_local__fs_list',
      'disabled_mcp__stale_tool',
      'yolo_local__removed_tool',
    ])

    expect(
      countEnabledVisibleAssistantTools(assistant, [
        tool('yolo_local__fs_list'),
      ]),
    ).toBe(1)
  })

  it('counts grouped built-in capabilities as one visible tool each', () => {
    const enabledToolNames = [
      'yolo_local__fs_edit',
      'yolo_local__fs_write',
      'yolo_local__memory_add',
      'yolo_local__memory_update',
      'yolo_local__memory_delete',
      'yolo_local__fs_read',
    ]

    expect(
      countEnabledVisibleAssistantTools(
        assistantWithTools(enabledToolNames),
        enabledToolNames.map(tool),
      ),
    ).toBe(3)
  })

  it('requires every currently visible group target to be enabled', () => {
    expect(
      countEnabledVisibleAssistantTools(
        assistantWithTools(['yolo_local__fs_edit']),
        [tool('yolo_local__fs_edit'), tool('yolo_local__fs_write')],
      ),
    ).toBe(0)
  })

  it('counts available remote MCP tools individually', () => {
    const assistant = assistantWithTools([
      'server__enabled_tool',
      'server__disabled_tool',
    ])
    assistant.toolPreferences = {
      server__disabled_tool: { enabled: false },
    }

    expect(
      countEnabledVisibleAssistantTools(assistant, [
        tool('server__enabled_tool'),
        tool('server__disabled_tool'),
      ]),
    ).toBe(1)
  })

  it('excludes built-in tools when the assistant disables them', () => {
    expect(
      countEnabledVisibleAssistantTools(
        assistantWithTools(['yolo_local__fs_read'], false),
        [tool('yolo_local__fs_read')],
      ),
    ).toBe(0)
  })
})
