import type { YoloSettings } from '../../settings/schema/setting.types'
import type { McpTool } from '../../types/mcp.types'

import {
  applyDynamicToolDescriptions,
  selectAllowedTools,
} from './tool-selection'

/** No provider-run tools, so the hosted web-search carve-out never applies. */
const MODEL_WITHOUT_HOSTED_TOOLS = {}

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
      model: MODEL_WITHOUT_HOSTED_TOOLS,
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
      model: MODEL_WITHOUT_HOSTED_TOOLS,
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
      model: MODEL_WITHOUT_HOSTED_TOOLS,
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
      'load_tool_schemas',
      'invoke_tool',
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
        model: MODEL_WITHOUT_HOSTED_TOOLS,
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
      )?.find((tool) => tool.function.name === 'invoke_tool')?.function
        .parameters.properties?.arguments

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
      model: MODEL_WITHOUT_HOSTED_TOOLS,
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
      model: MODEL_WITHOUT_HOSTED_TOOLS,
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
      model: MODEL_WITHOUT_HOSTED_TOOLS,
      allowedToolNames: ['server__tool_a'],
      toolPreferences: {
        server__tool_a: { enabled: true, approvalMode: 'full_access' },
      },
      apiType: 'anthropic',
    })

    expect(result.hasOnDemandTools).toBe(true)
    expect(result.requestTools?.map((tool) => tool.function.name)).toEqual([
      'load_tool_schemas',
      'invoke_tool',
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
      model: MODEL_WITHOUT_HOSTED_TOOLS,
      allowedToolNames: ['yolo_local__fs_read'],
      toolPreferences: { yolo_local__fs_read: { enabled: true } },
      apiType: 'anthropic',
    })

    expect(result.hasOnDemandTools).toBe(false)
    // Registered under the model-facing short name; the internal identity
    // (allow-list, preferences, gateway) stays fully qualified.
    expect(result.requestTools?.map((tool) => tool.function.name)).toEqual([
      'fs_read',
    ])
    expect(result.requestTools?.[0]?.function.parameters).toEqual({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    })
  })

  it('drops our web_search when the provider runs search itself', async () => {
    // Both would reach the model as the bare `web_search` — the name the
    // hosted tool's protocol fixes — so offering ours would be a duplicate
    // tool name, not merely a redundant option. `web_scrape` still earns its
    // place: hosted results carry titles and URLs but no page content.
    const availableTools: McpTool[] = [
      {
        name: 'yolo_local__web_search',
        description: 'Search the web',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'yolo_local__web_scrape',
        description: 'Scrape a page',
        inputSchema: { type: 'object', properties: {} },
      },
    ]
    const params = {
      availableTools,
      allowedToolNames: ['yolo_local__web_search', 'yolo_local__web_scrape'],
      toolPreferences: {
        yolo_local__web_search: { enabled: true },
        yolo_local__web_scrape: { enabled: true },
      },
      apiType: 'anthropic' as const,
    }

    const withHostedSearch = await selectAllowedTools({
      ...params,
      model: {
        builtinToolProvider: 'deepseek',
        builtinTools: { deepseek: { webSearch: { enabled: true } } },
      } as never,
    })
    expect(
      withHostedSearch.requestTools?.map((tool) => tool.function.name),
    ).toEqual(['web_scrape'])

    const withoutHostedSearch = await selectAllowedTools({
      ...params,
      model: MODEL_WITHOUT_HOSTED_TOOLS,
    })
    expect(
      withoutHostedSearch.requestTools?.map((tool) => tool.function.name),
    ).toEqual(['web_search', 'web_scrape'])
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
      model: MODEL_WITHOUT_HOSTED_TOOLS,
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
