import {
  getConversationDisplayTitle,
  isUntitledConversationTitle,
} from './conversationTitle'

describe('conversationTitle helpers', () => {
  it('treats empty and legacy defaults as untitled', () => {
    expect(isUntitledConversationTitle('')).toBe(true)
    expect(isUntitledConversationTitle('新对话')).toBe(true)
    expect(isUntitledConversationTitle('Named')).toBe(false)
    expect(getConversationDisplayTitle('', 'Fallback')).toBe('Fallback')
  })
})
