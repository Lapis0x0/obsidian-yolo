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
  | 'toolPreferences'
  | 'enabledToolNames'
  | 'includeBuiltinTools'
  | 'builtinCapabilityPreferences'
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

  // D9 (docs/plans/2026-08-15-tool-registry/phase2-migration.md D9): a
  // built-in capability's enabled state is now atomic — `file_editing`'s
  // `fs_edit`/`fs_write` can no longer be independently enabled/disabled via
  // `enabledToolNames`/`toolPreferences` (those no longer carry built-in
  // entries at all; only `builtinCapabilityPreferences` does, one entry per
  // *capability*, not per member tool). The pre-D9 version of this test
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
