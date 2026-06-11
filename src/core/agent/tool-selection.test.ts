import type { YoloSettings } from '../../settings/schema/setting.types'
import type { McpTool } from '../../types/mcp.types'

import { selectAllowedTools } from './tool-selection'

describe('selectAllowedTools', () => {
  it('keeps full schemas for tools left in always mode', () => {
    const availableTools: McpTool[] = [
      {
        name: 'server__tool_a',
        description: 'Tool A',
        inputSchema: {
          type: 'object',
          properties: { foo: { type: 'string' } },
        },
      },
    ]

    const result = selectAllowedTools({
      availableTools,
      allowedToolNames: ['server__tool_a'],
      toolPreferences: {
        server__tool_a: {
          enabled: true,
          approvalMode: 'full_access',
          disclosureMode: 'always',
        },
      },
    })

    expect(result.requestTools?.map((tool) => tool.function.name)).toEqual([
      'server__tool_a',
    ])
    expect(result.requestTools?.[0]?.function.parameters).toEqual({
      type: 'object',
      properties: { foo: { type: 'string' } },
    })
  })

  it('injects delegate_subagent model pool into the request schema', () => {
    const availableTools: McpTool[] = [
      {
        name: 'yolo_local__delegate_subagent',
        description: 'Dispatch a subagent.',
        inputSchema: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            prompt: { type: 'string' },
          },
          required: ['description', 'prompt'],
        },
      },
    ]
    const settings = {
      providers: [{ id: 'openai', apiType: 'openai-compatible' }],
      chatModelId: 'openai/gpt-5',
      chatModels: [
        {
          id: 'openai/gpt-5',
          providerId: 'openai',
          model: 'gpt-5',
          enable: true,
        },
        {
          id: 'openai/gpt-4.1-mini',
          providerId: 'openai',
          model: 'gpt-4.1-mini',
          enable: true,
        },
      ],
      mcp: {
        servers: [],
        enableToolDisclosure: false,
        builtinToolOptions: {
          delegate_subagent: {
            allowedModelIds: ['openai/gpt-4.1-mini'],
            preferredModelId: 'openai/gpt-4.1-mini',
          },
        },
      },
    } as unknown as YoloSettings

    const result = selectAllowedTools({
      availableTools,
      allowedToolNames: ['yolo_local__delegate_subagent'],
      toolPreferences: {
        yolo_local__delegate_subagent: {
          enabled: true,
          disclosureMode: 'always',
        },
      },
      settings,
    })

    const delegateTool = result.requestTools?.[0]
    expect(delegateTool?.function.description).toContain(
      'Recommended default: openai/gpt-4.1-mini',
    )
    expect(delegateTool?.function.parameters).toMatchObject({
      properties: {
        modelId: {
          type: 'string',
          enum: ['openai/gpt-4.1-mini'],
        },
      },
    })
  })

  it('replaces on-demand tools with a permissive stub schema (non-Gemini)', () => {
    const availableTools: McpTool[] = [
      {
        name: 'server__tool_a',
        description: 'Tool A real schema',
        inputSchema: {
          type: 'object',
          properties: { foo: { type: 'string' } },
          required: ['foo'],
        },
      },
    ]

    const result = selectAllowedTools({
      availableTools,
      allowedToolNames: ['server__tool_a'],
      toolPreferences: {
        server__tool_a: { enabled: true, disclosureMode: 'on_demand' },
      },
      apiType: 'anthropic',
    })

    // The loader is injected automatically whenever any surviving tool is
    // on-demand; it stays as a full schema and rides at the head of the list.
    expect(result.requestTools?.map((tool) => tool.function.name)).toEqual([
      'yolo_local__load_tool_schemas',
      'server__tool_a',
    ])
    const stub = result.requestTools?.find(
      (tool) => tool.function.name === 'server__tool_a',
    )
    expect(stub?.function.parameters).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: true,
    })
    expect(stub?.function.description).toContain('load_tool_schemas')
  })

  it('uses args_json stub form on Gemini', () => {
    const availableTools: McpTool[] = [
      {
        name: 'server__tool_a',
        description: 'Tool A',
        inputSchema: { type: 'object', properties: {} },
      },
    ]

    const result = selectAllowedTools({
      availableTools,
      allowedToolNames: ['server__tool_a'],
      toolPreferences: {
        server__tool_a: { enabled: true, disclosureMode: 'on_demand' },
      },
      apiType: 'gemini',
    })

    const stub = result.requestTools?.find(
      (tool) => tool.function.name === 'server__tool_a',
    )
    expect(stub?.function.parameters).toEqual({
      type: 'object',
      properties: {
        args_json: expect.objectContaining({ type: 'string' }),
      },
      required: ['args_json'],
    })
  })

  it('uses full schemas and skips loader injection when disclosure is disabled', () => {
    const availableTools: McpTool[] = [
      {
        name: 'server__tool_a',
        description: 'Tool A real schema',
        inputSchema: {
          type: 'object',
          properties: { foo: { type: 'string' } },
          required: ['foo'],
        },
      },
    ]

    const result = selectAllowedTools({
      availableTools,
      allowedToolNames: ['server__tool_a'],
      enableToolDisclosure: false,
      toolPreferences: {
        server__tool_a: { enabled: true, disclosureMode: 'on_demand' },
      },
    })

    expect(result.requestTools?.map((tool) => tool.function.name)).toEqual([
      'server__tool_a',
    ])
    expect(result.requestTools?.[0]?.function.parameters).toEqual({
      type: 'object',
      properties: { foo: { type: 'string' } },
      required: ['foo'],
    })
  })

  it('omits the loader when no surviving tool is on-demand', () => {
    const availableTools: McpTool[] = [
      {
        name: 'server__tool_a',
        description: 'Tool A',
        inputSchema: { type: 'object', properties: {} },
      },
    ]

    const result = selectAllowedTools({
      availableTools,
      allowedToolNames: ['server__tool_a'],
      toolPreferences: {
        server__tool_a: {
          enabled: true,
          disclosureMode: 'always',
        },
      },
    })

    expect(result.requestTools?.map((tool) => tool.function.name)).toEqual([
      'server__tool_a',
    ])
  })

  it('keeps the tools-field stable across identical selections', () => {
    const availableTools: McpTool[] = [
      {
        name: 'server__tool_a',
        description: 'Tool A',
        inputSchema: {
          type: 'object',
          properties: { foo: { type: 'string' } },
        },
      },
    ]
    const params = {
      availableTools,
      allowedToolNames: ['server__tool_a'],
      toolPreferences: {
        server__tool_a: { enabled: true, disclosureMode: 'on_demand' as const },
      },
      apiType: 'anthropic' as const,
    }

    const before = selectAllowedTools(params)
    const after = selectAllowedTools(params)

    expect(JSON.stringify(before.requestTools)).toEqual(
      JSON.stringify(after.requestTools),
    )
  })
})
