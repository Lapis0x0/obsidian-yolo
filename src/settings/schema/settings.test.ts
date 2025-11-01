import { SETTINGS_SCHEMA_VERSION } from './migrations'
import {
  DEFAULT_TAB_COMPLETION_OPTIONS,
  DEFAULT_TAB_COMPLETION_SYSTEM_PROMPT,
} from './setting.types'
import { parseSmartComposerSettings } from './settings'

describe('parseSmartComposerSettings', () => {
  it('should return default values for empty input', () => {
    const result = parseSmartComposerSettings({})
    expect(result.version).toBe(SETTINGS_SCHEMA_VERSION)

    expect(result.providers.length).toBeGreaterThan(0)
    expect(result.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'openai' }),
        expect.objectContaining({ type: 'anthropic' }),
      ]),
    )

    expect(result.chatModels.length).toBeGreaterThan(0)
    expect(
      result.chatModels.some((model) => model.id === result.chatModelId),
    ).toBe(true)
    expect(
      result.chatModels.some((model) => model.id === result.applyModelId),
    ).toBe(true)

    expect(result.embeddingModels.length).toBeGreaterThan(0)
    expect(
      result.embeddingModels.some(
        (model) => model.id === result.embeddingModelId,
      ),
    ).toBe(true)

    expect(result.systemPrompt).toBe('')

    expect(result.ragOptions).toMatchObject({
      enabled: true,
      chunkSize: 1000,
      thresholdTokens: 8192,
      minSimilarity: 0.0,
      limit: 10,
      autoUpdateEnabled: false,
      autoUpdateIntervalHours: 24,
      lastAutoUpdateAt: 0,
    })

    expect(result.mcp.servers).toEqual([])

    expect(result.chatOptions).toMatchObject({
      includeCurrentFileContent: true,
      enableBruteMode: false,
      enableLearningMode: false,
      enableTools: true,
      maxAutoIterations: 1,
      maxContextMessages: 32,
    })

    expect(result.continuationOptions).toMatchObject({
      enableSuperContinuation: true,
      enableSmartSpace: true,
      enableKeywordTrigger: true,
      triggerKeyword: 'cc',
      manualContextEnabled: false,
      stream: true,
      useVaultSearch: false,
      maxContinuationChars: 8000,
      enableTabCompletion: false,
      tabCompletionSystemPrompt: DEFAULT_TAB_COMPLETION_SYSTEM_PROMPT,
    })
    expect(result.continuationOptions.tabCompletionOptions).toMatchObject(
      DEFAULT_TAB_COMPLETION_OPTIONS,
    )
    expect(result.continuationOptions.smartSpaceQuickActions).toBeUndefined()

    expect(result.assistants).toEqual([])
    expect(result.language).toBe('en')
  })
})
