import { SETTINGS_SCHEMA_VERSION } from './migrations'
import {
  DEFAULT_TAB_COMPLETION_LENGTH_PRESET,
  DEFAULT_TAB_COMPLETION_OPTIONS,
  DEFAULT_TAB_COMPLETION_SYSTEM_PROMPT,
  DEFAULT_TAB_COMPLETION_TRIGGERS,
} from './setting.types'
import { parseSmartComposerSettings } from './settings'

describe('parseSmartComposerSettings', () => {
  it('should return default values for empty input', () => {
    const result = parseSmartComposerSettings({})
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
      autoUpdateEnabled: false,
      autoUpdateIntervalHours: 24,
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
      chatMode: 'chat',
      agentModeWarningConfirmed: false,
      reasoningLevelByModelId: {},
      tabTitleFollowsConversation: true,
      chatExportFolder: 'YOLO Exports',
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
  })

  it('migrates applyModelId to chatTitleModelId for legacy settings', () => {
    const result = parseSmartComposerSettings({
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

  it('defaults tabTitleFollowsConversation to true for legacy chat options', () => {
    const result = parseSmartComposerSettings({
      version: SETTINGS_SCHEMA_VERSION,
      chatOptions: {
        includeCurrentFileContent: true,
      },
    })

    expect(result.chatOptions.tabTitleFollowsConversation).toBe(true)
  })

  it('migrates version 41 settings to include qwen oauth defaults', () => {
    const result = parseSmartComposerSettings({
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

  it('keeps valid providers when one provider entry is invalid', () => {
    const result = parseSmartComposerSettings({
      version: SETTINGS_SCHEMA_VERSION,
      providers: [
        {
          id: 'openai',
          presetType: 'openai',
          apiKey: 'token',
        },
        {
          id: 'broken',
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
    ])
  })

  it('normalizes legacy kimi providers without clearing the provider list', () => {
    const result = parseSmartComposerSettings({
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
    const result = parseSmartComposerSettings({
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

  it('clears invalid model references when no valid models remain after parsing', () => {
    const result = parseSmartComposerSettings({
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
})
