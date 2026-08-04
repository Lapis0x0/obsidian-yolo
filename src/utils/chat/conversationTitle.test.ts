import {
  getConversationDisplayTitle,
  getGeneratedTitleToApply,
  isUntitledConversationTitle,
} from './conversationTitle'

describe('conversationTitle helpers', () => {
  it('treats empty and legacy defaults as untitled', () => {
    expect(isUntitledConversationTitle('')).toBe(true)
    expect(isUntitledConversationTitle('新对话')).toBe(true)
    expect(isUntitledConversationTitle('Named')).toBe(false)
    expect(getConversationDisplayTitle('', 'Fallback')).toBe('Fallback')
  })

  it('does not apply an automatic title over a title edited during generation', () => {
    expect(
      getGeneratedTitleToApply({
        currentTitle: '用户手动命名',
        generatedTitle: '模型生成的标题',
      }),
    ).toBeNull()
    expect(
      getGeneratedTitleToApply({
        currentTitle: '用户手动命名',
        generatedTitle: '模型生成的标题',
        force: true,
      }),
    ).toBe('模型生成的标题')
  })
})
