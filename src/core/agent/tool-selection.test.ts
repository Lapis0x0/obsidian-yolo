import type { YoloSettings } from '../../settings/schema/setting.types'
import type { McpTool } from '../../types/mcp.types'

import {
  applyDynamicToolDescriptions,
  selectAllowedTools,
} from './tool-selection'

describe('selectAllowedTools', () => {
  it('keeps full schemas for tools left in always mode', async () => {
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

    const result = await selectAllowedTools({
      availableTools,
      allowedToolNames: ['server__tool_a'],
      toolPreferences: {
        server__tool_a: {
          enabled: true,
          approvalMode: 'full_access',
        },
      },
      toolServerPreferences: { server: { disclosureMode: 'always' } },
    })

    expect(result.requestTools?.map((tool) => tool.function.name)).toEqual([
      'server__tool_a',
    ])
    expect(result.requestTools?.[0]?.function.parameters).toEqual({
      type: 'object',
      properties: { foo: { type: 'string' } },
    })
  })

  it('injects delegate_subagent model pool into the request schema', async () => {
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
        builtinCapabilityOptions: {
          subagent_delegation: {
            allowedModelIds: ['openai/gpt-4.1-mini'],
            preferredModelId: 'openai/gpt-4.1-mini',
          },
        },
      },
    } as unknown as YoloSettings

    const result = await selectAllowedTools({
      availableTools,
      allowedToolNames: ['yolo_local__delegate_subagent'],
      toolPreferences: {
        yolo_local__delegate_subagent: {
          enabled: true,
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

  it('does not register deferred tools at all, injecting the two protocol tools instead', async () => {
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

    const result = await selectAllowedTools({
      availableTools,
      allowedToolNames: ['server__tool_a'],
      toolPreferences: {
        server__tool_a: { enabled: true },
      },
      toolServerPreferences: { server: { disclosureMode: 'on_demand' } },
      apiType: 'anthropic',
    })

    // A deferred tool costs a catalog line, not a `tools` entry — so the
    // registered set is exactly the two protocol tools.
    expect(result.requestTools?.map((tool) => tool.function.name)).toEqual([
      'yolo_local__load_tool_schemas',
      'yolo_local__invoke_tool',
    ])
    expect(result.hasOnDemandTools).toBe(true)
    // ...but the gateway still needs the real definition to validate against.
    expect(result.filteredTools.map((tool) => tool.name)).toContain(
      'server__tool_a',
    )
  })

  it('gives invoke_tool a native object for arguments, and a JSON string only on Gemini', async () => {
    const availableTools: McpTool[] = [
      {
        name: 'server__tool_a',
        description: 'Tool A',
        inputSchema: { type: 'object', properties: {} },
      },
    ]
    const select = (apiType: 'anthropic' | 'gemini') =>
      selectAllowedTools({
        availableTools,
        allowedToolNames: ['server__tool_a'],
        toolPreferences: { server__tool_a: { enabled: true } },
        toolServerPreferences: { server: { disclosureMode: 'on_demand' } },
        apiType,
      })
    const argumentsSchemaOf = (result: { requestTools?: unknown[] }) =>
      (
        result.requestTools as
          | Array<{
              function: {
                name: string
                parameters: { properties?: Record<string, unknown> }
              }
            }>
          | undefined
      )?.find((tool) => tool.function.name === 'yolo_local__invoke_tool')
        ?.function.parameters.properties?.arguments

    expect(argumentsSchemaOf(await select('anthropic'))).toMatchObject({
      type: 'object',
      additionalProperties: true,
    })
    expect(argumentsSchemaOf(await select('gemini'))).toMatchObject({
      type: 'string',
    })
  })

  it('keeps a tool set the user pinned to always registered natively', async () => {
    // The escape hatch that replaced the global opt-out: it is per tool set,
    // and it puts the real schema back in `tools` rather than routing the
    // call through invoke_tool.
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

    const result = await selectAllowedTools({
      availableTools,
      allowedToolNames: ['server__tool_a'],
      toolPreferences: { server__tool_a: { enabled: true } },
      toolServerPreferences: { server: { disclosureMode: 'always' } },
      apiType: 'anthropic',
    })

    expect(result.hasOnDemandTools).toBe(false)
    expect(result.requestTools?.map((tool) => tool.function.name)).toEqual([
      'server__tool_a',
    ])
    expect(result.requestTools?.[0]?.function.parameters).toEqual({
      type: 'object',
      properties: { foo: { type: 'string' } },
      required: ['foo'],
    })
    expect(result.deferredToolCatalog).toBeNull()
  })

  it('omits the loader when no surviving tool is on-demand', async () => {
    const availableTools: McpTool[] = [
      {
        name: 'server__tool_a',
        description: 'Tool A',
        inputSchema: { type: 'object', properties: {} },
      },
    ]

    const result = await selectAllowedTools({
      availableTools,
      allowedToolNames: ['server__tool_a'],
      toolPreferences: {
        server__tool_a: {
          enabled: true,
        },
      },
      toolServerPreferences: { server: { disclosureMode: 'always' } },
    })

    expect(result.requestTools?.map((tool) => tool.function.name)).toEqual([
      'server__tool_a',
    ])
  })

  it('defers every MCP server by default, regardless of how small its schemas are', async () => {
    // The old default weighed a per-server token budget against a 2000-token
    // threshold. That existed only because deferral was opt-in; with it on by
    // default the threshold just left small servers inexplicably resident.
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

    const result = await selectAllowedTools({
      availableTools,
      allowedToolNames: ['server__tool_a'],
      toolPreferences: {
        server__tool_a: { enabled: true, approvalMode: 'full_access' },
      },
      apiType: 'anthropic',
    })

    expect(result.hasOnDemandTools).toBe(true)
    expect(result.requestTools?.map((tool) => tool.function.name)).toEqual([
      'yolo_local__load_tool_schemas',
      'yolo_local__invoke_tool',
    ])
  })

  it('keeps host built-ins registered natively', async () => {
    const availableTools: McpTool[] = [
      {
        name: 'yolo_local__fs_read',
        description: 'Read a file',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    ]

    const result = await selectAllowedTools({
      availableTools,
      allowedToolNames: ['yolo_local__fs_read'],
      toolPreferences: { yolo_local__fs_read: { enabled: true } },
      apiType: 'anthropic',
    })

    expect(result.hasOnDemandTools).toBe(false)
    expect(result.requestTools?.map((tool) => tool.function.name)).toEqual([
      'yolo_local__fs_read',
    ])
    expect(result.requestTools?.[0]?.function.parameters).toEqual({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    })
  })

  it('keeps the tools-field stable across identical selections', async () => {
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
        server__tool_a: { enabled: true },
      },
      toolServerPreferences: {
        server: { disclosureMode: 'on_demand' as const },
      },
      apiType: 'anthropic' as const,
    }

    const before = await selectAllowedTools(params)
    const after = await selectAllowedTools(params)

    expect(JSON.stringify(before.requestTools)).toEqual(
      JSON.stringify(after.requestTools),
    )
  })
})

describe('applyDynamicToolDescriptions', () => {
  const knowledgeBases = [
    {
      id: 'kb-1',
      name: '读书笔记',
      description: '书摘与书评',
      include: [],
      exclude: [],
    },
    { id: 'kb-2', name: 'Work', description: '', include: [], exclude: [] },
  ]
  const settings = { knowledgeBases } as unknown as YoloSettings
  const tools: McpTool[] = [
    {
      name: 'yolo_local__bash',
      description: 'static',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'yolo_local__js_eval',
      description: 'static',
      inputSchema: { type: 'object', properties: {} },
    },
  ]

  it('lists the configured knowledge bases in bash and js_eval descriptions', () => {
    const [bash, jsEval] = applyDynamicToolDescriptions(tools, {
      jsSandboxSettings: { allowDbQuery: true },
      settings,
    })
    for (const tool of [bash, jsEval]) {
      expect(tool.description).toContain('- 读书笔记 - 书摘与书评')
      expect(tool.description).toContain('- Work')
    }
    expect(bash.description).toContain('--kb')
    expect(jsEval.description).toContain(
      '$db.search(query, limit?, knowledgeBase?)',
    )
  })

  it('tells the model when no knowledge base exists', () => {
    const [bash] = applyDynamicToolDescriptions(tools, {
      jsSandboxSettings: {},
      settings: { knowledgeBases: [] } as unknown as YoloSettings,
    })
    expect(bash.description).toContain('No knowledge bases are configured')
  })
})
