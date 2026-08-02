import { buildConversationTitleInput } from './generateConversationTitle'

describe('buildConversationTitleInput', () => {
  it('builds title input from plain prompt content', () => {
    expect(
      buildConversationTitleInput({
        role: 'user',
        id: 'u1',
        content: null,
        promptContent: 'Fix the scroll bug',
        mentionables: [],
      }),
    ).toBe('User first message:\nFix the scroll bug')
  })

  it('returns null when the user message has no signal', () => {
    expect(
      buildConversationTitleInput({
        role: 'user',
        id: 'u1',
        content: null,
        promptContent: null,
        mentionables: [],
      }),
    ).toBeNull()
  })
})
