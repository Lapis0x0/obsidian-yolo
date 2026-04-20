import { parseSmartComposerSettings } from '../../settings/schema/settings'

import {
  DEFAULT_ASSISTANT_ID,
  ensureDefaultAssistantInSettings,
} from './default-assistant'

const createBaseSettings = () =>
  parseSmartComposerSettings({
    chatModelId: 'model-a',
    continuationOptions: {
      enableTabCompletion: false,
      tabCompletionSystemPrompt: '',
      tabCompletionLengthPreset: 'medium',
      quickAskContextBeforeChars: 5000,
      quickAskContextAfterChars: 2000,
      tabCompletionOptions: {
        idleTriggerEnabled: false,
        autoTriggerDelayMs: 3000,
        autoTriggerCooldownMs: 15000,
        triggerDelayMs: 3000,
        minContextLength: 20,
        contextRange: 4000,
        maxSuggestionLength: 2000,
        temperature: 0.5,
        requestTimeoutMs: 12000,
      },
      tabCompletionTriggers: [],
    },
  })

describe('ensureDefaultAssistantInSettings', () => {
  it('preserves timestamps for an already normalized default assistant', () => {
    const settings = {
      ...createBaseSettings(),
      assistants: [
        {
          id: DEFAULT_ASSISTANT_ID,
          name: 'Default',
          description: 'Default editing agent for sidebar chat.',
          systemPrompt: '',
          modelId: 'model-a',
          persona: 'balanced' as const,
          enableTools: true,
          includeBuiltinTools: true,
          enabledToolNames: [],
          enabledSkills: [],
          skillPreferences: {},
          createdAt: 111,
          updatedAt: 222,
        },
      ],
      currentAssistantId: DEFAULT_ASSISTANT_ID,
    }

    const result = ensureDefaultAssistantInSettings(settings)

    expect(result.assistants[0]?.createdAt).toBe(111)
    expect(result.assistants[0]?.updatedAt).toBe(222)
  })

  it('refreshes updatedAt when default assistant normalization changes fields', () => {
    const originalNow = Date.now
    Date.now = jest.fn(() => 999)

    try {
      const settings = {
        ...createBaseSettings(),
        chatModelId: 'model-b',
        assistants: [
          {
            id: DEFAULT_ASSISTANT_ID,
            name: '',
            description: '',
            systemPrompt: '',
            createdAt: 111,
            updatedAt: 222,
          },
        ],
        currentAssistantId: DEFAULT_ASSISTANT_ID,
      }

      const result = ensureDefaultAssistantInSettings(settings)

      expect(result.assistants[0]?.name).toBe('Default')
      expect(result.assistants[0]?.updatedAt).toBe(999)
      expect(result.assistants[0]?.createdAt).toBe(111)
    } finally {
      Date.now = originalNow
    }
  })
})
