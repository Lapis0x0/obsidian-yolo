import type { McpTool } from '../../types/mcp.types'

import { selectAllowedTools } from './tool-selection'

describe('selectAllowedTools', () => {
  it('filters out open_skill when no allowed skills are provided', () => {
    const availableTools: McpTool[] = [
      {
        name: 'yolo_local__open_skill',
        description: 'Open skill',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ]

    expect(
      selectAllowedTools({
        availableTools,
      }),
    ).toEqual({
      filteredTools: [],
      hasTools: false,
      hasMemoryTools: false,
      requestTools: undefined,
    })
  })

  it('keeps open_skill when skill allowlist is present', () => {
    const availableTools: McpTool[] = [
      {
        name: 'yolo_local__open_skill',
        description: 'Open skill',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ]

    const result = selectAllowedTools({
      availableTools,
      allowedSkillIds: ['skill-1'],
    })

    expect(result.filteredTools).toHaveLength(1)
    expect(result.hasTools).toBe(true)
    expect(result.hasMemoryTools).toBe(false)
    expect(result.requestTools).toEqual([
      {
        type: 'function',
        function: {
          name: 'yolo_local__open_skill',
          description: 'Open skill',
          parameters: {
            type: 'object',
            properties: {},
          },
        },
      },
    ])
  })
})
