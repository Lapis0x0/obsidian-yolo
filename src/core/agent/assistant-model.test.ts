import {
  ASSISTANT_FOLLOW_DEFAULT_MODEL_OPTION_VALUE,
  followsDefaultChatModel,
  getAssistantModelDisplayLabel,
  getAssistantModelSelectValue,
  modelIdFromAssistantModelSelectValue,
  resolveAssistantModelId,
} from './assistant-model'

describe('assistant-model', () => {
  it('treats empty modelId as follow-default', () => {
    expect(followsDefaultChatModel(undefined)).toBe(true)
    expect(followsDefaultChatModel('')).toBe(true)
    expect(followsDefaultChatModel('gpt-4')).toBe(false)
  })

  it('resolves follow-default to the current chat model', () => {
    expect(resolveAssistantModelId(undefined, 'chat-default')).toBe(
      'chat-default',
    )
    expect(resolveAssistantModelId('fixed-model', 'chat-default')).toBe(
      'fixed-model',
    )
  })

  it('maps select values to and from persisted modelId', () => {
    expect(getAssistantModelSelectValue(undefined)).toBe(
      ASSISTANT_FOLLOW_DEFAULT_MODEL_OPTION_VALUE,
    )
    expect(getAssistantModelSelectValue('gpt-4')).toBe('gpt-4')
    expect(
      modelIdFromAssistantModelSelectValue(
        ASSISTANT_FOLLOW_DEFAULT_MODEL_OPTION_VALUE,
      ),
    ).toBeUndefined()
    expect(modelIdFromAssistantModelSelectValue('gpt-4')).toBe('gpt-4')
  })

  it('displays follow-default label instead of a concrete model', () => {
    expect(
      getAssistantModelDisplayLabel(undefined, 'Follow default model'),
    ).toBe('Follow default model')
    expect(getAssistantModelDisplayLabel('gpt-4', 'Follow default model')).toBe(
      'gpt-4',
    )
  })
})
