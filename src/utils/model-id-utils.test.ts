import { detectReasoningTypeFromModelId } from './model-id-utils'

describe('model-id-utils', () => {
  it('classifies DeepSeek V4 as OpenAI-compatible reasoning by model id', () => {
    expect(detectReasoningTypeFromModelId('deepseek-v4-pro')).toBe('openai')
    expect(detectReasoningTypeFromModelId('deepseek/deepseek-v4-flash')).toBe(
      'openai',
    )
    expect(
      detectReasoningTypeFromModelId('provider/custom-deepseek-v4-pro'),
    ).toBe('openai')
    expect(detectReasoningTypeFromModelId('deepseek-chat')).toBe('none')
  })
})
