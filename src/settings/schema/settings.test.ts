import {
  DEFAULT_APPLY_MODEL_ID,
  DEFAULT_CHAT_MODELS,
  DEFAULT_CHAT_MODEL_ID,
  DEFAULT_CONTINUATION_SYSTEM_PROMPT,
  DEFAULT_EMBEDDING_MODELS,
  DEFAULT_PROVIDERS,
} from '../../constants'

import { SETTINGS_SCHEMA_VERSION } from './migrations'
import {
  DEFAULT_TAB_COMPLETION_OPTIONS,
  DEFAULT_TAB_COMPLETION_SYSTEM_PROMPT,
} from './setting.types'
import { parseSmartComposerSettings } from './settings'

describe('parseSmartComposerSettings', () => {
  it('should return default values for empty input', () => {
    const result = parseSmartComposerSettings({})
    expect(result).toEqual({
      version: SETTINGS_SCHEMA_VERSION,

      providers: [...DEFAULT_PROVIDERS],

      chatModels: [...DEFAULT_CHAT_MODELS],
      embeddingModels: [...DEFAULT_EMBEDDING_MODELS],

      chatModelId: DEFAULT_CHAT_MODEL_ID,
      applyModelId: DEFAULT_APPLY_MODEL_ID,
      embeddingModelId: 'openai/text-embedding-3-small',

      systemPrompt: '',

      ragOptions: {
        enabled: true,
        chunkSize: 1000,
        thresholdTokens: 8192,
        minSimilarity: 0.0,
        limit: 10,
        excludePatterns: [],
        includePatterns: [],
        autoUpdateEnabled: false,
        autoUpdateIntervalHours: 24,
        lastAutoUpdateAt: 0,
      },

      mcp: {
        servers: [],
      },

      chatOptions: {
        includeCurrentFileContent: true,
        enableBruteMode: false,
        enableLearningMode: false,
        learningModePrompt: '',
        enableTools: true,
        maxAutoIterations: 1,
        maxContextMessages: 32,
        defaultTemperature: 0.8,
        defaultTopP: 0.9,
        chatTitlePrompt: '',
        baseModelSpecialPrompt: '',
      },

      continuationOptions: {
        enableSuperContinuation: true,
        continuationModelId: 'openai/gpt-4.1-mini',
        defaultSystemPrompt: DEFAULT_CONTINUATION_SYSTEM_PROMPT,
        enableKeywordTrigger: true,
        triggerKeyword: '  ',
        manualContextEnabled: false,
        manualContextFolders: [],
        referenceRuleFolders: [],
        knowledgeBaseFolders: [],
        stream: true,
        useVaultSearch: false,
        maxContinuationChars: 8000,
        enableFloatingPanelKeywordTrigger: false,
        floatingPanelTriggerKeyword: '',
        enableTabCompletion: false,
        tabCompletionModelId: 'openai/gpt-4.1-mini',
        tabCompletionOptions: { ...DEFAULT_TAB_COMPLETION_OPTIONS },
        tabCompletionSystemPrompt: DEFAULT_TAB_COMPLETION_SYSTEM_PROMPT,
      },

      assistants: [],
      language: 'en',
    })
  })
})
