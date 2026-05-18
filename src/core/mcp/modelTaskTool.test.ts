jest.mock('../llm/manager', () => ({
  getChatModelClient: (...args: unknown[]) => mockGetChatModelClient(...args),
}))

jest.mock('../ai/single-turn', () => ({
  executeSingleTurn: (...args: unknown[]) => mockExecuteSingleTurn(...args),
}))

import type { YoloSettings } from '../../settings/schema/setting.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

import {
  MODEL_TASK_TOOL_NAME,
  buildRunModelTaskTool,
  executeModelTaskTool,
} from './modelTaskTool'
import { getToolName } from './tool-name-utils'

const mockGetChatModelClient = jest.fn()
const mockExecuteSingleTurn = jest.fn()

const localServerName = 'yolo_local'
const sourceFullName = (toolName: string) =>
  getToolName(localServerName, toolName)

const childModel = {
  providerId: 'openai',
  id: 'openai/child',
  model: 'gpt-child',
  name: 'Child',
  enable: true,
  temperature: 0.2,
  topP: 0.8,
  maxOutputTokens: 1234,
  modalities: ['text'],
}

const capableChildModel = {
  ...childModel,
  id: 'openai/capable-child',
  model: 'gpt-capable-child',
  name: 'Capable child',
}

const reasoningChildModel = {
  ...childModel,
  id: 'openai/reasoning-child',
  model: 'gpt-reasoning-child',
  name: 'Reasoning child',
  reasoningType: 'openai',
}

const visionChildModel = {
  ...childModel,
  id: 'openai/vision-child',
  model: 'gpt-vision-child',
  name: 'Vision child',
  modalities: ['text', 'vision'],
}

const pdfChildModel = {
  ...childModel,
  id: 'openai/pdf-child',
  model: 'gpt-pdf-child',
  name: 'PDF child',
  modalities: ['text', 'pdf'],
}

const baseSettings = {
  providers: [
    { id: 'openai', presetType: 'openai', apiType: 'openai-responses' },
  ],
  chatModels: [childModel],
  agentLlmTools: {
    enabled: true,
    categories: [
      {
        id: 'economy',
        name: 'Economy',
        description: 'Fast and cheap',
      },
    ],
    modelTools: [
      {
        id: 'tool-1',
        modelId: childModel.id,
        categoryId: 'economy',
        enabled: true,
      },
    ],
  },
} as unknown as YoloSettings

const fullAccess = (toolName: string) => ({
  allowedToolNames: [sourceFullName(toolName)],
  toolPreferences: {
    [sourceFullName(toolName)]: {
      enabled: true,
      approvalMode: 'full_access' as const,
    },
  },
})

const fullAccessTool = (fullName: string) => ({
  allowedToolNames: [fullName],
  toolPreferences: {
    [fullName]: {
      enabled: true,
      approvalMode: 'full_access' as const,
    },
  },
})

const settingsWithModel = (model: typeof childModel) =>
  ({
    ...baseSettings,
    chatModels: [model],
    agentLlmTools: {
      ...baseSettings.agentLlmTools,
      modelTools: [
        {
          id: `tool-${model.id}`,
          modelId: model.id,
          categoryId: 'economy',
          enabled: true,
        },
      ],
    },
  }) as unknown as YoloSettings

beforeEach(() => {
  mockGetChatModelClient.mockReset()
  mockExecuteSingleTurn.mockReset()
  mockGetChatModelClient.mockReturnValue({
    providerClient: { id: 'provider' },
    model: childModel,
  })
  mockExecuteSingleTurn.mockResolvedValue({
    content: 'child result',
    usage: { prompt_tokens: 1, completion_tokens: 2 },
    toolCalls: [],
  })
})

describe('buildRunModelTaskTool', () => {
  it('uses enabled configured child models as the target enum', () => {
    const tool = buildRunModelTaskTool(baseSettings)
    expect(tool?.name).toBe(MODEL_TASK_TOOL_NAME)
    const properties = tool?.inputSchema.properties as Record<string, unknown>
    expect(properties.targetModelId).toMatchObject({
      type: 'string',
      enum: [childModel.id],
    })
    expect(tool?.description).toContain('Child')
    expect(tool?.description).toContain('Economy')
  })

  it('exposes unified sub-model reasoning controls and model support', () => {
    const tool = buildRunModelTaskTool(settingsWithModel(reasoningChildModel))
    const properties = tool?.inputSchema.properties as Record<string, unknown>

    expect(properties.reasoning).toMatchObject({
      type: 'object',
      properties: {
        level: {
          enum: ['off', 'auto', 'low', 'medium', 'high', 'extra-high'],
        },
        returnReasoning: { type: 'boolean' },
      },
    })
    expect(tool?.description).toContain('reasoning: openai')
  })

  it('does not build a runtime tool when no enabled child models exist', () => {
    const settings = {
      ...baseSettings,
      agentLlmTools: {
        ...baseSettings.agentLlmTools,
        modelTools: [],
      },
    } as unknown as YoloSettings

    expect(buildRunModelTaskTool(settings)).toBeNull()
  })

  it('can narrow the target enum to a specific agent-selected model', () => {
    const settings = {
      ...baseSettings,
      chatModels: [childModel, capableChildModel],
      agentLlmTools: {
        ...baseSettings.agentLlmTools,
        categories: [
          ...baseSettings.agentLlmTools.categories,
          {
            id: 'capable',
            name: 'Capable',
            description: 'Deep work',
          },
        ],
        modelTools: [
          ...baseSettings.agentLlmTools.modelTools,
          {
            id: 'tool-2',
            modelId: capableChildModel.id,
            categoryId: 'capable',
            enabled: true,
          },
        ],
      },
    } as unknown as YoloSettings

    const tool = buildRunModelTaskTool(settings, {
      allowedModelIds: [capableChildModel.id],
    })
    const properties = tool?.inputSchema.properties as Record<string, unknown>
    expect(properties.targetModelId).toMatchObject({
      enum: [capableChildModel.id],
    })
    expect(tool?.description).toContain('Capable child')
    expect(tool?.description).not.toContain('targetModelId: openai/child')
  })

  it('can narrow models and source tools from per-agent options', () => {
    const tool = buildRunModelTaskTool(baseSettings, {
      allowedModelIds: [childModel.id],
      enabledSourceToolNames: ['fs_read'],
    })
    const properties = tool?.inputSchema.properties as Record<string, unknown>
    expect(properties.targetModelId).toMatchObject({
      enum: [childModel.id],
    })
    expect(properties.source).toMatchObject({
      properties: {
        toolName: {
          enum: ['fs_read'],
        },
      },
    })

    const withoutSource = buildRunModelTaskTool(baseSettings, {
      sourceToolsEnabled: false,
    })
    expect(
      (withoutSource?.inputSchema.properties as Record<string, unknown>).source,
    ).toBeUndefined()
  })

  it('exposes explicitly enabled MCP source tools only when MCP source tools are on', () => {
    const mcpToolName = 'docs__lookup'
    const withMcp = buildRunModelTaskTool(baseSettings, {
      enabledSourceToolNames: ['fs_read', mcpToolName],
      mcpSourceToolsEnabled: true,
    })
    expect(
      (
        (
          withMcp?.inputSchema.properties as {
            source: { properties: { toolName: { enum: string[] } } }
          }
        ).source.properties.toolName as Record<string, unknown>
      ).enum,
    ).toEqual(['fs_read', mcpToolName])

    const withoutMcp = buildRunModelTaskTool(baseSettings, {
      enabledSourceToolNames: ['fs_read', mcpToolName],
      mcpSourceToolsEnabled: false,
    })
    expect(
      (
        (
          withoutMcp?.inputSchema.properties as {
            source: { properties: { toolName: { enum: string[] } } }
          }
        ).source.properties.toolName as Record<string, unknown>
      ).enum,
    ).toEqual(['fs_read'])
  })
})

describe('executeModelTaskTool', () => {
  it('runs a direct child LLM request with the configured model params', async () => {
    const result = await executeModelTaskTool({
      settings: baseSettings,
      localServerName,
      args: {
        targetModelId: childModel.id,
        childSystemPrompt: 'system',
        instruction: 'do the task',
      },
      callSourceTool: jest.fn(),
      debugTraceId: 'main-debug-trace',
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) return
    expect(JSON.parse(result.text)).toMatchObject({
      ok: true,
      childOutput: 'child result',
      meta: {
        targetModelId: childModel.id,
        targetModelLabel: 'Child',
      },
    })
    expect(mockExecuteSingleTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        model: childModel,
        stream: false,
        purpose: 'auxiliary',
        debugTraceId: 'main-debug-trace',
        request: expect.objectContaining({
          model: childModel.model,
          temperature: childModel.temperature,
          top_p: childModel.topP,
          max_tokens: childModel.maxOutputTokens,
          messages: [
            { role: 'system', content: 'system' },
            {
              role: 'user',
              content: expect.stringContaining('do the task'),
            },
          ],
        }),
      }),
    )
    expect(
      mockExecuteSingleTurn.mock.calls[0]?.[0].request.messages[1].content,
    ).toEqual(expect.stringContaining('Delegated sub-model task'))
    expect(
      mockExecuteSingleTurn.mock.calls[0]?.[0].request.messages[1].content,
    ).toEqual(expect.stringContaining('received_text_chars'))
  })

  it('tells the main model to inspect child intake checks', () => {
    const tool = buildRunModelTaskTool(baseSettings)

    expect(tool?.description).toEqual(
      expect.stringContaining('inspect that intake check'),
    )
    expect(tool?.description).toEqual(
      expect.stringContaining('point out the anomaly to the user'),
    )
  })

  it('passes requested sub-model reasoning level without returning reasoning by default', async () => {
    mockGetChatModelClient.mockReturnValueOnce({
      providerClient: { id: 'provider' },
      model: reasoningChildModel,
    })
    mockExecuteSingleTurn.mockResolvedValueOnce({
      content: 'child result',
      reasoning: 'private child reasoning',
      usage: { prompt_tokens: 1, completion_tokens: 2 },
      toolCalls: [],
    })

    const result = await executeModelTaskTool({
      settings: settingsWithModel(reasoningChildModel),
      localServerName,
      args: {
        targetModelId: reasoningChildModel.id,
        childSystemPrompt: 'system',
        instruction: 'think carefully',
        reasoning: { level: 'high' },
      },
      callSourceTool: jest.fn(),
    })

    expect(mockExecuteSingleTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        model: reasoningChildModel,
        preserveReasoning: true,
        request: expect.objectContaining({
          reasoningLevel: 'high',
        }),
      }),
    )
    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) return
    const parsed = JSON.parse(result.text)
    expect(parsed).toMatchObject({
      ok: true,
      meta: { childReasoningLevel: 'high' },
    })
    expect(parsed.childReasoning).toBeUndefined()
  })

  it('returns sub-model reasoning only when explicitly requested', async () => {
    mockGetChatModelClient.mockReturnValueOnce({
      providerClient: { id: 'provider' },
      model: reasoningChildModel,
    })
    mockExecuteSingleTurn.mockResolvedValueOnce({
      content: 'child result',
      reasoning: 'visible child reasoning',
      usage: { prompt_tokens: 1, completion_tokens: 2 },
      toolCalls: [],
    })

    const result = await executeModelTaskTool({
      settings: settingsWithModel(reasoningChildModel),
      localServerName,
      args: {
        targetModelId: reasoningChildModel.id,
        childSystemPrompt: 'system',
        instruction: 'think carefully',
        reasoning: { level: 'medium', returnReasoning: true },
      },
      callSourceTool: jest.fn(),
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) return
    expect(JSON.parse(result.text)).toMatchObject({
      ok: true,
      childOutput: 'child result',
      childReasoning: 'visible child reasoning',
      meta: { childReasoningLevel: 'medium' },
    })
  })

  it('rejects reasoning levels for child models without reasoning support', async () => {
    const result = await executeModelTaskTool({
      settings: baseSettings,
      localServerName,
      args: {
        targetModelId: childModel.id,
        childSystemPrompt: 'system',
        instruction: 'task',
        reasoning: { level: 'high' },
      },
      callSourceTool: jest.fn(),
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) return
    expect(JSON.parse(result.text)).toMatchObject({
      ok: false,
      error: { stage: 'validation' },
    })
    expect(mockExecuteSingleTurn).not.toHaveBeenCalled()
  })

  it('validates target models against the agent-selected model restriction', async () => {
    const result = await executeModelTaskTool({
      settings: baseSettings,
      localServerName,
      args: {
        targetModelId: childModel.id,
        childSystemPrompt: 'system',
        instruction: 'task',
      },
      runtimeOptions: { allowedModelIds: ['openai/other-child'] },
      callSourceTool: jest.fn(),
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) return
    expect(JSON.parse(result.text)).toMatchObject({
      ok: false,
      error: { stage: 'validation' },
    })
    expect(mockExecuteSingleTurn).not.toHaveBeenCalled()
  })

  it('sends source text to the child but not to the public result', async () => {
    const sentinel = 'SENTINEL_SOURCE_TEXT_SHOULD_NOT_LEAK_TO_MAIN'
    const callSourceTool = jest.fn().mockResolvedValue({
      status: ToolCallResponseStatus.Success,
      text: sentinel,
    })

    const result = await executeModelTaskTool({
      settings: baseSettings,
      localServerName,
      args: {
        targetModelId: childModel.id,
        childSystemPrompt: 'system',
        instruction: 'summarize source',
        source: {
          toolName: 'fs_read',
          args: {
            paths: ['note.md'],
            operation: { type: 'full', modality: 'text' },
          },
        },
      },
      agentToolAccess: fullAccess('fs_read'),
      callSourceTool,
    })

    expect(callSourceTool).toHaveBeenCalledWith(
      {
        kind: 'local',
        localToolName: 'fs_read',
        fullToolName: sourceFullName('fs_read'),
        displayName: 'fs_read',
      },
      {
        paths: ['note.md'],
        operation: { type: 'full', modality: 'text' },
      },
      {
        targetModel: childModel,
        targetModelId: childModel.id,
      },
    )
    expect(mockExecuteSingleTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'user',
              content: expect.stringContaining(sentinel),
            }),
          ]),
        }),
      }),
    )
    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) return
    expect(result.text).not.toContain(sentinel)
    expect(JSON.parse(result.text)).toMatchObject({
      ok: true,
      meta: {
        sourceToolName: 'fs_read',
        sourceResultChars: sentinel.length,
        sourceResultModalities: ['text'],
      },
    })
  })

  it('passes Markdown image content parts to a vision child without exposing them in the public result', async () => {
    mockGetChatModelClient.mockReturnValueOnce({
      providerClient: { id: 'provider' },
      model: visionChildModel,
    })
    const imagePart = {
      type: 'image_url' as const,
      image_url: {
        url: 'data:image/png;base64,IMAGE_SENTINEL_SHOULD_NOT_LEAK',
      },
    }
    const result = await executeModelTaskTool({
      settings: settingsWithModel(visionChildModel),
      localServerName,
      args: {
        targetModelId: visionChildModel.id,
        childSystemPrompt: 'system',
        instruction: 'inspect image',
        source: {
          toolName: 'fs_read',
          args: {
            paths: ['note.md'],
            operation: { type: 'full' },
          },
        },
      },
      agentToolAccess: fullAccess('fs_read'),
      callSourceTool: jest.fn().mockResolvedValue({
        status: ToolCallResponseStatus.Success,
        text: 'markdown body',
        contentParts: [imagePart],
      }),
    })

    const userMessage =
      mockExecuteSingleTurn.mock.calls[0]?.[0].request.messages[1]
    expect(userMessage.content).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('markdown body'),
      }),
      imagePart,
    ])
    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) return
    expect(result.text).not.toContain('IMAGE_SENTINEL_SHOULD_NOT_LEAK')
    expect(JSON.parse(result.text)).toMatchObject({
      ok: true,
      meta: {
        sourceResultModalities: ['text', 'image'],
      },
    })
  })

  it('passes PDF document content parts to a PDF-capable child', async () => {
    mockGetChatModelClient.mockReturnValueOnce({
      providerClient: { id: 'provider' },
      model: pdfChildModel,
    })
    const documentPart = {
      type: 'document' as const,
      mediaType: 'application/pdf' as const,
      name: 'source.pdf',
      data: 'PDF_SENTINEL_SHOULD_NOT_LEAK',
      pageCount: 2,
    }
    const result = await executeModelTaskTool({
      settings: settingsWithModel(pdfChildModel),
      localServerName,
      args: {
        targetModelId: pdfChildModel.id,
        childSystemPrompt: 'system',
        instruction: 'read pdf',
        source: {
          toolName: 'fs_read',
          args: {
            paths: ['source.pdf'],
            operation: { type: 'lines', startLine: 1, modality: 'pdf' },
          },
        },
      },
      agentToolAccess: fullAccess('fs_read'),
      callSourceTool: jest.fn().mockResolvedValue({
        status: ToolCallResponseStatus.Success,
        text: 'pdf routing note',
        contentParts: [documentPart],
      }),
    })

    expect(
      mockExecuteSingleTurn.mock.calls[0]?.[0].request.messages[1].content,
    ).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('pdf routing note'),
      }),
      documentPart,
    ])
    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) return
    expect(result.text).not.toContain('PDF_SENTINEL_SHOULD_NOT_LEAK')
    expect(JSON.parse(result.text)).toMatchObject({
      ok: true,
      meta: {
        sourceResultModalities: ['text', 'pdf'],
      },
    })
  })

  it('passes PDF page render image parts to a vision child', async () => {
    mockGetChatModelClient.mockReturnValueOnce({
      providerClient: { id: 'provider' },
      model: visionChildModel,
    })
    const renderedPage = {
      type: 'image_url' as const,
      image_url: {
        url: 'data:image/png;base64,PDF_PAGE_IMAGE_SENTINEL',
      },
    }
    await executeModelTaskTool({
      settings: settingsWithModel(visionChildModel),
      localServerName,
      args: {
        targetModelId: visionChildModel.id,
        childSystemPrompt: 'system',
        instruction: 'inspect rendered page',
        source: {
          toolName: 'fs_read',
          args: {
            paths: ['source.pdf'],
            operation: { type: 'lines', startLine: 1, modality: 'image' },
          },
        },
      },
      agentToolAccess: fullAccess('fs_read'),
      callSourceTool: jest.fn().mockResolvedValue({
        status: ToolCallResponseStatus.Success,
        text: 'rendered page note',
        contentParts: [renderedPage],
      }),
    })

    expect(
      mockExecuteSingleTurn.mock.calls[0]?.[0].request.messages[1].content,
    ).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('rendered page note'),
      }),
      renderedPage,
    ])
  })

  it('returns validation errors for unsupported requested or returned source modalities', async () => {
    const explicitPdf = await executeModelTaskTool({
      settings: baseSettings,
      localServerName,
      args: {
        targetModelId: childModel.id,
        childSystemPrompt: 'system',
        instruction: 'read pdf',
        source: {
          toolName: 'fs_read',
          args: {
            paths: ['source.pdf'],
            operation: { type: 'full', modality: 'pdf' },
          },
        },
      },
      agentToolAccess: fullAccess('fs_read'),
      callSourceTool: jest.fn(),
    })
    expect(explicitPdf.status).toBe(ToolCallResponseStatus.Success)
    if (explicitPdf.status !== ToolCallResponseStatus.Success) return
    expect(JSON.parse(explicitPdf.text)).toMatchObject({
      ok: false,
      error: { stage: 'validation' },
    })
    expect(mockExecuteSingleTurn).not.toHaveBeenCalled()

    const returnedImage = await executeModelTaskTool({
      settings: baseSettings,
      localServerName,
      args: {
        targetModelId: childModel.id,
        childSystemPrompt: 'system',
        instruction: 'inspect image',
        source: {
          toolName: 'fs_read',
          args: {
            paths: ['note.md'],
            operation: { type: 'full' },
          },
        },
      },
      agentToolAccess: fullAccess('fs_read'),
      callSourceTool: jest.fn().mockResolvedValue({
        status: ToolCallResponseStatus.Success,
        text: 'body',
        contentParts: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,IMG' },
          },
        ],
      }),
    })
    expect(returnedImage.status).toBe(ToolCallResponseStatus.Success)
    if (returnedImage.status !== ToolCallResponseStatus.Success) return
    expect(JSON.parse(returnedImage.text)).toMatchObject({
      ok: false,
      error: { stage: 'validation' },
    })
  })

  it('runs explicitly enabled MCP source tools as text-only source material', async () => {
    const mcpToolName = 'docs__lookup'
    const sourceText = 'MCP_SOURCE_SENTINEL_SHOULD_NOT_LEAK'
    const callSourceTool = jest.fn().mockResolvedValue({
      status: ToolCallResponseStatus.Success,
      text: sourceText,
    })

    const result = await executeModelTaskTool({
      settings: baseSettings,
      localServerName,
      args: {
        targetModelId: childModel.id,
        childSystemPrompt: 'system',
        instruction: 'summarize mcp result',
        source: {
          toolName: mcpToolName,
          args: { query: 'topic' },
        },
      },
      runtimeOptions: {
        mcpSourceToolsEnabled: true,
        enabledSourceToolNames: [mcpToolName],
      },
      agentToolAccess: fullAccessTool(mcpToolName),
      callSourceTool,
    })

    expect(callSourceTool).toHaveBeenCalledWith(
      {
        kind: 'mcp',
        localToolName: 'lookup',
        fullToolName: mcpToolName,
        displayName: mcpToolName,
      },
      { query: 'topic' },
      {
        targetModel: childModel,
        targetModelId: childModel.id,
      },
    )
    expect(
      mockExecuteSingleTurn.mock.calls[0]?.[0].request.messages[1].content,
    ).toEqual(expect.stringContaining(sourceText))
    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) return
    expect(result.text).not.toContain(sourceText)
  })

  it('rejects MCP source tools unless the agent explicitly enables MCP and the exact tool', async () => {
    const mcpToolName = 'docs__lookup'
    for (const runtimeOptions of [
      { enabledSourceToolNames: [mcpToolName], mcpSourceToolsEnabled: false },
      { enabledSourceToolNames: [], mcpSourceToolsEnabled: true },
    ]) {
      const result = await executeModelTaskTool({
        settings: baseSettings,
        localServerName,
        args: {
          targetModelId: childModel.id,
          childSystemPrompt: 'system',
          instruction: 'task',
          source: {
            toolName: mcpToolName,
            args: {},
          },
        },
        runtimeOptions,
        agentToolAccess: fullAccessTool(mcpToolName),
        callSourceTool: jest.fn(),
      })
      expect(result.status).toBe(ToolCallResponseStatus.Success)
      if (result.status !== ToolCallResponseStatus.Success) return
      expect(JSON.parse(result.text)).toMatchObject({
        ok: false,
        error: { stage: 'validation' },
      })
    }
  })

  it('returns validation errors for unavailable child models', async () => {
    const result = await executeModelTaskTool({
      settings: baseSettings,
      localServerName,
      args: {
        targetModelId: 'missing',
        childSystemPrompt: 'system',
        instruction: 'task',
      },
      callSourceTool: jest.fn(),
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) return
    expect(JSON.parse(result.text)).toMatchObject({
      ok: false,
      error: { stage: 'validation' },
    })
    expect(mockExecuteSingleTurn).not.toHaveBeenCalled()
  })

  it('rejects source tools that are not enabled with full access', async () => {
    const callSourceTool = jest.fn()
    const result = await executeModelTaskTool({
      settings: baseSettings,
      localServerName,
      args: {
        targetModelId: childModel.id,
        childSystemPrompt: 'system',
        instruction: 'task',
        source: {
          toolName: 'fs_search',
          args: { query: 'x' },
        },
      },
      agentToolAccess: {
        allowedToolNames: [sourceFullName('fs_search')],
        toolPreferences: {
          [sourceFullName('fs_search')]: {
            enabled: true,
            approvalMode: 'require_approval',
          },
        },
      },
      callSourceTool,
    })

    expect(callSourceTool).not.toHaveBeenCalled()
    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) return
    expect(JSON.parse(result.text)).toMatchObject({
      ok: false,
      error: { stage: 'validation' },
    })
  })

  it('rejects source tools disabled by per-agent model task options', async () => {
    const callSourceTool = jest.fn()
    const result = await executeModelTaskTool({
      settings: baseSettings,
      localServerName,
      args: {
        targetModelId: childModel.id,
        childSystemPrompt: 'system',
        instruction: 'task',
        source: {
          toolName: 'fs_search',
          args: { query: 'x' },
        },
      },
      runtimeOptions: { enabledSourceToolNames: ['fs_read'] },
      agentToolAccess: fullAccess('fs_search'),
      callSourceTool,
    })

    expect(callSourceTool).not.toHaveBeenCalled()
    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) return
    expect(JSON.parse(result.text)).toMatchObject({
      ok: false,
      error: { stage: 'validation' },
    })
  })

  it('returns a validation error before overflowing the child context window', async () => {
    const tinyModel = {
      ...childModel,
      maxContextTokens: 1,
      maxOutputTokens: 1,
    }
    mockGetChatModelClient.mockReturnValueOnce({
      providerClient: { id: 'provider' },
      model: tinyModel,
    })

    const result = await executeModelTaskTool({
      settings: {
        ...baseSettings,
        chatModels: [tinyModel],
      } as unknown as YoloSettings,
      localServerName,
      args: {
        targetModelId: childModel.id,
        childSystemPrompt: 'system',
        instruction: 'task',
      },
      callSourceTool: jest.fn(),
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) return
    expect(JSON.parse(result.text)).toMatchObject({
      ok: false,
      error: {
        stage: 'validation',
      },
      meta: {
        childContextWindowTokens: 1,
      },
    })
    expect(mockExecuteSingleTurn).not.toHaveBeenCalled()
  })

  it('rejects recursive and write source tools', async () => {
    for (const toolName of [MODEL_TASK_TOOL_NAME, 'fs_edit']) {
      const result = await executeModelTaskTool({
        settings: baseSettings,
        localServerName,
        args: {
          targetModelId: childModel.id,
          childSystemPrompt: 'system',
          instruction: 'task',
          source: {
            toolName,
            args: {},
          },
        },
        agentToolAccess: fullAccess(toolName),
        callSourceTool: jest.fn(),
      })

      expect(result.status).toBe(ToolCallResponseStatus.Success)
      if (result.status !== ToolCallResponseStatus.Success) return
      expect(JSON.parse(result.text)).toMatchObject({
        ok: false,
        error: { stage: 'validation' },
      })
    }
  })

  it('returns source_tool errors when the source tool fails', async () => {
    const result = await executeModelTaskTool({
      settings: baseSettings,
      localServerName,
      args: {
        targetModelId: childModel.id,
        childSystemPrompt: 'system',
        instruction: 'task',
        source: {
          toolName: 'web_search',
          args: { query: 'x' },
        },
      },
      agentToolAccess: fullAccess('web_search'),
      callSourceTool: jest.fn().mockResolvedValue({
        status: ToolCallResponseStatus.Error,
        error: 'provider failed',
      }),
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) return
    expect(JSON.parse(result.text)).toMatchObject({
      ok: false,
      error: { stage: 'source_tool', message: 'provider failed' },
    })
  })

  it('returns source_tool errors when the first-stage source tool throws', async () => {
    const result = await executeModelTaskTool({
      settings: baseSettings,
      localServerName,
      args: {
        targetModelId: childModel.id,
        childSystemPrompt: 'system',
        instruction: 'task',
        source: {
          toolName: 'web_search',
          args: { query: 'x' },
        },
      },
      agentToolAccess: fullAccess('web_search'),
      callSourceTool: jest.fn().mockRejectedValue(new Error('network failed')),
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) return
    expect(JSON.parse(result.text)).toMatchObject({
      ok: false,
      error: {
        stage: 'source_tool',
        message: 'network failed',
        retryable: true,
      },
    })
    expect(mockExecuteSingleTurn).not.toHaveBeenCalled()
  })

  it('returns child_llm errors for child failures and invalid JSON output', async () => {
    mockExecuteSingleTurn.mockRejectedValueOnce(new Error('child failed'))
    const failed = await executeModelTaskTool({
      settings: baseSettings,
      localServerName,
      args: {
        targetModelId: childModel.id,
        childSystemPrompt: 'system',
        instruction: 'task',
      },
      callSourceTool: jest.fn(),
    })
    expect(failed.status).toBe(ToolCallResponseStatus.Success)
    if (failed.status !== ToolCallResponseStatus.Success) return
    expect(JSON.parse(failed.text)).toMatchObject({
      ok: false,
      error: { stage: 'child_llm', message: 'child failed' },
    })

    mockExecuteSingleTurn.mockResolvedValueOnce({
      content: 'not json',
      toolCalls: [],
    })
    const invalidJson = await executeModelTaskTool({
      settings: baseSettings,
      localServerName,
      args: {
        targetModelId: childModel.id,
        childSystemPrompt: 'system',
        instruction: 'task',
        outputMode: 'json',
      },
      callSourceTool: jest.fn(),
    })
    expect(invalidJson.status).toBe(ToolCallResponseStatus.Success)
    if (invalidJson.status !== ToolCallResponseStatus.Success) return
    expect(JSON.parse(invalidJson.text)).toMatchObject({
      ok: false,
      error: { stage: 'child_llm' },
    })
  })

  it('instructs JSON mode to return a single object and rejects non-object JSON', async () => {
    mockExecuteSingleTurn.mockResolvedValueOnce({
      content: JSON.stringify({
        received_text_chars: 0,
        prefix_sample: '',
        suffix_sample: '',
        result: 'ok',
      }),
      usage: { prompt_tokens: 1, completion_tokens: 2 },
      toolCalls: [],
    })

    const validObject = await executeModelTaskTool({
      settings: baseSettings,
      localServerName,
      args: {
        targetModelId: childModel.id,
        childSystemPrompt: 'system',
        instruction: 'return structured data',
        outputMode: 'json',
      },
      callSourceTool: jest.fn(),
    })

    expect(validObject.status).toBe(ToolCallResponseStatus.Success)
    const userContent =
      mockExecuteSingleTurn.mock.calls[0]?.[0].request.messages[1].content
    expect(userContent).toEqual(
      expect.stringContaining('entire output must be one valid JSON object'),
    )
    expect(userContent).toEqual(expect.stringContaining('no Markdown fences'))
    if (validObject.status !== ToolCallResponseStatus.Success) return
    expect(JSON.parse(validObject.text)).toMatchObject({ ok: true })

    mockExecuteSingleTurn.mockResolvedValueOnce({
      content: '[]',
      usage: { prompt_tokens: 1, completion_tokens: 2 },
      toolCalls: [],
    })

    const arrayJson = await executeModelTaskTool({
      settings: baseSettings,
      localServerName,
      args: {
        targetModelId: childModel.id,
        childSystemPrompt: 'system',
        instruction: 'return structured data',
        outputMode: 'json',
      },
      callSourceTool: jest.fn(),
    })

    expect(arrayJson.status).toBe(ToolCallResponseStatus.Success)
    if (arrayJson.status !== ToolCallResponseStatus.Success) return
    expect(JSON.parse(arrayJson.text)).toMatchObject({
      ok: false,
      error: {
        stage: 'child_llm',
        message: 'Sub LLM output was not a single valid JSON object.',
      },
    })
  })
})
