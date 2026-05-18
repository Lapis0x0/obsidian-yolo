import { SETTINGS_SCHEMA_VERSION } from './migrations'
import {
  DEFAULT_AGENT_LLM_TOOLS,
  DEFAULT_TAB_COMPLETION_LENGTH_PRESET,
  DEFAULT_TAB_COMPLETION_OPTIONS,
  DEFAULT_TAB_COMPLETION_SYSTEM_PROMPT,
  DEFAULT_TAB_COMPLETION_TRIGGERS,
} from './setting.types'
import { parseYoloSettings } from './settings'

describe('parseYoloSettings', () => {
  it('should return default values for empty input', () => {
    const result = parseYoloSettings({})
    expect(result.version).toBe(SETTINGS_SCHEMA_VERSION)

    expect(result.providers).toEqual([])

    expect(result.chatModels).toEqual([])
    expect(result.chatModelId).toBe('')
    expect(result.chatTitleModelId).toBe('')

    expect(result.embeddingModels).toEqual([])
    expect(result.embeddingModelId).toBe('')

    expect(result.systemPrompt).toBe('')

    expect(result.ragOptions).toMatchObject({
      enabled: true,
      chunkSize: 1000,
      thresholdTokens: 20000,
      minSimilarity: 0.0,
      limit: 10,
      indexPdf: true,
      autoUpdateEnabled: true,
      autoUpdateIntervalHours: 0,
      lastAutoUpdateAt: 0,
    })

    expect(result.mcp.servers).toEqual([])
    expect(result.yolo).toEqual({ baseDir: 'YOLO' })

    expect(result.chatOptions).toMatchObject({
      includeCurrentFileContent: true,
      mentionDisplayMode: 'inline',
      mentionContextMode: 'light',
      chatInputHeight: undefined,
      chatApplyMode: 'review-required',
      chatMode: 'agent',
      agentModeWarningConfirmed: false,
      reasoningLevelByModelId: {},
    })

    expect(result.notificationOptions).toMatchObject({
      enabled: false,
      channel: 'sound',
      timing: 'when-unfocused',
      notifyOnApprovalRequired: true,
      notifyOnTaskCompleted: true,
    })

    expect(result.continuationOptions).toMatchObject({
      enableTabCompletion: false,
      tabCompletionSystemPrompt: DEFAULT_TAB_COMPLETION_SYSTEM_PROMPT,
      tabCompletionLengthPreset: DEFAULT_TAB_COMPLETION_LENGTH_PRESET,
      quickAskContextBeforeChars: 5000,
      quickAskContextAfterChars: 2000,
    })
    expect(result.continuationOptions.tabCompletionOptions).toMatchObject(
      DEFAULT_TAB_COMPLETION_OPTIONS,
    )
    expect(result.continuationOptions.tabCompletionTriggers).toEqual(
      expect.arrayContaining(DEFAULT_TAB_COMPLETION_TRIGGERS),
    )
    expect(result.continuationOptions.smartSpaceQuickActions).toBeUndefined()

    expect(result.assistants).toEqual([])
    expect(result.agentLlmTools).toEqual(DEFAULT_AGENT_LLM_TOOLS)
  })

  it('migrates applyModelId to chatTitleModelId for legacy settings', () => {
    const result = parseYoloSettings({
      version: 38,
      providers: [
        {
          id: 'openai',
          presetType: 'openai',
          apiKey: 'token',
        },
      ],
      chatModels: [
        {
          providerId: 'openai',
          id: 'openai/gpt-5',
          model: 'gpt-5',
          enable: true,
        },
        {
          providerId: 'openai',
          id: 'openai/gpt-4.1-mini',
          model: 'gpt-4.1-mini',
          enable: true,
        },
      ],
      chatModelId: 'openai/gpt-5',
      applyModelId: 'openai/gpt-4.1-mini',
    })

    expect(result.version).toBe(SETTINGS_SCHEMA_VERSION)
    expect(result.chatTitleModelId).toBe('openai/gpt-4.1-mini')
  })

  it('migrates version 41 settings to include qwen oauth defaults', () => {
    const result = parseYoloSettings({
      version: 41,
      providers: [
        {
          id: 'openai',
          presetType: 'openai',
          apiKey: 'token',
        },
      ],
      chatModels: [
        {
          providerId: 'openai',
          id: 'openai/gpt-5',
          model: 'gpt-5',
          enable: true,
        },
      ],
    })

    expect(result.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'qwen-oauth',
          presetType: 'qwen-oauth',
        }),
      ]),
    )
    expect(result.chatModels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'qwen-oauth/coder-model',
          providerId: 'qwen-oauth',
        }),
      ]),
    )
  })

  it('migrates legacy rag auto update interval 24 hours to 0', () => {
    const result = parseYoloSettings({
      version: 43,
      ragOptions: {
        autoUpdateEnabled: true,
        autoUpdateIntervalHours: 24,
      },
    })

    expect(result.version).toBe(SETTINGS_SCHEMA_VERSION)
    expect(result.ragOptions.autoUpdateIntervalHours).toBe(0)
  })

  // Regression: previously the entry with an unrecognized presetType was
  // silently dropped by `resilientArraySchema`. When users sync settings from
  // a newer plugin version (with a preset this version doesn't know yet),
  // that drop was wiping providers across devices. Unknown presets must now
  // degrade to `openai-compatible` and stay in the list.
  it('preserves providers with unknown presetType by coercing to openai-compatible', () => {
    const result = parseYoloSettings({
      version: SETTINGS_SCHEMA_VERSION,
      providers: [
        {
          id: 'openai',
          presetType: 'openai',
          apiKey: 'token',
        },
        {
          id: 'from-future',
          presetType: 'not-a-provider',
        },
      ],
    })

    expect(result.providers).toEqual([
      {
        id: 'openai',
        presetType: 'openai',
        apiType: 'openai-responses',
        apiKey: 'token',
      },
      {
        id: 'from-future',
        presetType: 'openai-compatible',
        apiType: 'openai-compatible',
      },
    ])
  })

  it('normalizes legacy kimi providers without clearing the provider list', () => {
    const result = parseYoloSettings({
      version: SETTINGS_SCHEMA_VERSION,
      providers: [
        {
          id: 'moonshot',
          presetType: 'kimi',
          apiKey: 'token',
        },
        {
          id: 'openai',
          presetType: 'openai',
          apiKey: 'token-2',
        },
      ],
    })

    expect(result.providers).toEqual([
      {
        id: 'moonshot',
        presetType: 'moonshot',
        apiType: 'openai-compatible',
        apiKey: 'token',
      },
      {
        id: 'openai',
        presetType: 'openai',
        apiType: 'openai-responses',
        apiKey: 'token-2',
      },
    ])
  })

  it('drops orphan chat and embedding models when their providers are missing', () => {
    const result = parseYoloSettings({
      version: SETTINGS_SCHEMA_VERSION,
      providers: [
        {
          id: 'openai',
          presetType: 'openai',
          apiKey: 'token',
        },
      ],
      chatModels: [
        {
          providerId: 'openai',
          id: 'openai/gpt-5',
          model: 'gpt-5',
          enable: true,
        },
        {
          providerId: 'missing-provider',
          id: 'missing/model',
          model: 'missing',
          enable: true,
        },
      ],
      embeddingModels: [
        {
          providerId: 'missing-provider',
          id: 'missing/embed',
          model: 'missing-embed',
          dimension: 1024,
        },
      ],
      chatModelId: 'missing/model',
      chatTitleModelId: 'missing/model',
      embeddingModelId: 'missing/embed',
      continuationOptions: {
        continuationModelId: 'missing/model',
        tabCompletionModelId: 'missing/model',
      },
      assistants: [
        {
          id: 'assistant-1',
          name: 'Assistant 1',
          modelId: 'missing/model',
        },
      ],
      currentAssistantId: 'missing-assistant',
      quickAskAssistantId: 'missing-assistant',
    })

    expect(result.chatModels).toEqual([
      {
        providerId: 'openai',
        id: 'openai/gpt-5',
        model: 'gpt-5',
        enable: true,
      },
    ])
    expect(result.embeddingModels).toEqual([])
    expect(result.chatModelId).toBe('openai/gpt-5')
    expect(result.chatTitleModelId).toBe('openai/gpt-5')
    expect(result.embeddingModelId).toBe('')
    expect(result.continuationOptions.continuationModelId).toBe('openai/gpt-5')
    expect(result.continuationOptions.tabCompletionModelId).toBe('openai/gpt-5')
    expect(result.assistants).toEqual([
      {
        id: 'assistant-1',
        name: 'Assistant 1',
        modelId: undefined,
        systemPrompt: '',
      },
    ])
    expect(result.currentAssistantId).toBeUndefined()
    expect(result.quickAskAssistantId).toBeUndefined()
  })

  it('migrates v56 settings to include agent LLM tool defaults', () => {
    const result = parseYoloSettings({
      version: 56,
    })

    expect(result.version).toBe(SETTINGS_SCHEMA_VERSION)
    expect(result.agentLlmTools).toEqual(DEFAULT_AGENT_LLM_TOOLS)
  })

  it('normalizes agent LLM model tools when chat models are missing or disabled', () => {
    const result = parseYoloSettings({
      version: SETTINGS_SCHEMA_VERSION,
      providers: [
        {
          id: 'openai',
          presetType: 'openai',
          apiKey: 'token',
        },
      ],
      chatModels: [
        {
          providerId: 'openai',
          id: 'openai/enabled',
          model: 'enabled',
          enable: true,
        },
        {
          providerId: 'openai',
          id: 'openai/disabled',
          model: 'disabled',
          enable: false,
        },
      ],
      agentLlmTools: {
        enabled: true,
        categories: [
          {
            id: 'custom',
            name: 'Custom',
            description: 'Keep me',
          },
        ],
        modelTools: [
          {
            id: 'keep',
            modelId: 'openai/enabled',
            categoryId: 'custom',
            enabled: true,
          },
          {
            id: 'drop-disabled',
            modelId: 'openai/disabled',
            categoryId: 'custom',
            enabled: true,
          },
          {
            id: 'drop-missing',
            modelId: 'openai/missing',
            categoryId: 'custom',
            enabled: true,
          },
        ],
      },
      assistants: [
        {
          id: 'assistant-keep-model-tool',
          name: 'Keep',
          modelToolModelId: 'openai/enabled',
        },
        {
          id: 'assistant-drop-model-tool',
          name: 'Drop',
          modelToolModelId: 'openai/disabled',
        },
      ],
    })

    expect(result.agentLlmTools.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'custom',
          description: 'Keep me',
        }),
        expect.objectContaining({ id: 'economy' }),
        expect.objectContaining({ id: 'capable' }),
      ]),
    )
    expect(result.agentLlmTools.modelTools).toEqual([
      {
        id: 'keep',
        modelId: 'openai/enabled',
        categoryId: 'custom',
        enabled: true,
      },
    ])
    expect(result.assistants).toEqual([
      {
        id: 'assistant-keep-model-tool',
        name: 'Keep',
        systemPrompt: '',
        modelToolModelId: 'openai/enabled',
      },
      {
        id: 'assistant-drop-model-tool',
        name: 'Drop',
        systemPrompt: '',
        modelToolModelId: undefined,
      },
    ])
  })

  it('preserves explicitly allowed MCP source tools while cleaning invalid local model-task source tools', () => {
    const result = parseYoloSettings({
      version: SETTINGS_SCHEMA_VERSION,
      providers: [{ id: 'openai', presetType: 'openai' }],
      chatModels: [
        {
          providerId: 'openai',
          id: 'openai/enabled',
          model: 'enabled',
          enable: true,
        },
      ],
      agentLlmTools: {
        enabled: true,
        categories: [
          {
            id: 'economy',
            name: 'Economy',
            description: 'Fast',
          },
        ],
        modelTools: [
          {
            id: 'model-tool',
            modelId: 'openai/enabled',
            categoryId: 'economy',
            enabled: true,
          },
        ],
      },
      assistants: [
        {
          id: 'assistant',
          name: 'Agent',
          modelToolOptions: {
            mcpSourceToolsEnabled: true,
            enabledSourceToolNames: ['fs_read', 'fs_edit', 'docs__lookup'],
          },
        },
      ],
    })

    expect(result.assistants[0]?.modelToolOptions).toMatchObject({
      mcpSourceToolsEnabled: true,
      enabledSourceToolNames: ['fs_read', 'docs__lookup'],
    })
  })

  it('clears invalid model references when no valid models remain after parsing', () => {
    const result = parseYoloSettings({
      version: SETTINGS_SCHEMA_VERSION,
      providers: [
        {
          id: 'openai',
          presetType: 'openai',
          apiKey: 'token',
        },
      ],
      chatModels: [
        {
          providerId: 'openai',
          id: '',
          model: 'broken',
          enable: true,
        },
      ],
      embeddingModels: [
        {
          providerId: 'openai',
          id: '',
          model: 'broken-embed',
          dimension: 1024,
        },
      ],
      chatModelId: 'broken/model',
      chatTitleModelId: 'broken/model',
      embeddingModelId: 'broken/embed',
      continuationOptions: {
        continuationModelId: 'broken/model',
        tabCompletionModelId: 'broken/model',
      },
    })

    expect(result.chatModels).toEqual([])
    expect(result.embeddingModels).toEqual([])
    expect(result.chatModelId).toBe('')
    expect(result.chatTitleModelId).toBe('')
    expect(result.embeddingModelId).toBe('')
    expect(result.continuationOptions.continuationModelId).toBe('')
    expect(result.continuationOptions.tabCompletionModelId).toBe('')
  })

  it('deduplicates embedding models with the same provider and model', () => {
    const result = parseYoloSettings({
      version: SETTINGS_SCHEMA_VERSION,
      providers: [
        {
          id: 'openai',
          presetType: 'openai',
          apiKey: 'token',
        },
      ],
      embeddingModels: [
        {
          providerId: 'openai',
          id: 'openai/text-embedding-3-large',
          model: 'text-embedding-3-large',
          name: 'text-embedding-3-large',
          dimension: 3072,
        },
        {
          providerId: 'openai',
          id: 'openai/text-embedding-3-large-2',
          model: 'text-embedding-3-large',
          name: 'text-embedding-3-large',
          dimension: 3072,
        },
      ],
      embeddingModelId: 'openai/text-embedding-3-large-2',
    })

    expect(result.embeddingModels).toEqual([
      {
        providerId: 'openai',
        id: 'openai/text-embedding-3-large',
        model: 'text-embedding-3-large',
        name: 'text-embedding-3-large',
        dimension: 3072,
      },
    ])
    expect(result.embeddingModelId).toBe('openai/text-embedding-3-large')
  })
})
