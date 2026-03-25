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
      chatInputHeight: undefined,
      chatApplyMode: 'review-required',
      chatMode: 'chat',
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
  })

  it('migrates applyModelId to chatTitleModelId for legacy settings', () => {
    const result = parseSmartComposerSettings({
      version: 38,
      chatModelId: 'openai/gpt-5',
      applyModelId: 'openai/gpt-4.1-mini',
    })

    expect(result.version).toBe(SETTINGS_SCHEMA_VERSION)
    expect(result.chatTitleModelId).toBe('openai/gpt-4.1-mini')
  })
})
