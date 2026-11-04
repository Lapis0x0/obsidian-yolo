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
): Pick<
  Assistant,
  'toolPreferences' | 'enabledToolNames' | 'builtinCapabilityPreferences'
> => ({
  enabledToolNames,
  toolPreferences: {},
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
      'yolo_local__web_search',
      'yolo_local__web_scrape',
      'yolo_local__fs_read',
    ]

    expect(
      countEnabledVisibleAssistantTools(
        assistantWithTools(enabledToolNames),
        enabledToolNames.map(tool),
      ),
    ).toBe(3)
  })

  // A built-in capability's enabled state is now atomic — `file_editing`'s
  // `fs_edit`/`fs_write` can no longer be independently enabled/disabled via
  // `enabledToolNames`/`toolPreferences` (those no longer carry built-in
  // entries at all; only `builtinCapabilityPreferences` does, one entry per
  // *capability*, not per member tool). The earlier version of this test
  // simulated a "partial" group via a stale `enabledToolNames` list
  // containing only `fs_edit` — that path no longer has any effect on
  // built-in enablement, so it now covers the still-real "whole capability
  // disabled" case instead: every one of its currently visible members must
  // be hidden together.
  it('hides every currently visible group target when the capability is disabled', () => {
    expect(
      countEnabledVisibleAssistantTools(
        {
          ...assistantWithTools([]),
          builtinCapabilityPreferences: { file_editing: { enabled: false } },
        },
        [tool('yolo_local__fs_edit'), tool('yolo_local__fs_write')],
      ),
    ).toBe(0)
  })

  // `native_files` is on by default, but the editor offers no switch for it
  // (Max forces it on, and no other mode exposes it). The chat agent selector
  // once showed `1 tool` beside an editor reading `0 / 5 active` because only
  // the editor dropped it before counting.
  it('leaves out built-in tools the assistant cannot switch', () => {
    expect(
      countEnabledVisibleAssistantTools(assistantWithTools([]), [
        tool('yolo_local__read_file'),
        tool('yolo_local__write_file'),
        tool('yolo_local__edit_file'),
        tool('yolo_local__fs_read'),
      ]),
    ).toBe(1)
  })

  it('counts a module tool set as one, and only while the module contributes it', () => {
    const toolNames = [
      'yolo_whiteboard__create_board',
      'yolo_whiteboard__edit_board',
    ]
    const moduleToolSets = [
      {
        serverName: 'yolo_whiteboard',
        toolNames: ['create_board', 'edit_board'],
      },
    ]

    expect(
      countEnabledVisibleAssistantTools(
        assistantWithTools(toolNames),
        toolNames.map(tool),
        moduleToolSets,
      ),
    ).toBe(1)

    // The module is gone: its tools leave the catalog with it, and nothing a
    // stale preference says can put the row back into the count.
    expect(
      countEnabledVisibleAssistantTools(assistantWithTools(toolNames), [], []),
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
})
