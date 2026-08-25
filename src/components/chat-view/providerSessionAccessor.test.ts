import type { ChatMessage } from '../../types/chat'

import { resolveTurnIdentity } from './providerSessionAccessor'

const user = (id: string) => ({ role: 'user', id }) as unknown as ChatMessage
const assistant = (id: string) =>
  ({ role: 'assistant', id }) as unknown as ChatMessage

describe('resolveTurnIdentity', () => {
  it('has no turn when nothing has been said', () => {
    expect(resolveTurnIdentity([])).toEqual({
      turnId: undefined,
      parentTurnId: undefined,
    })
  })

  it('opens a conversation with no parent', () => {
    expect(resolveTurnIdentity([user('u1')])).toEqual({
      turnId: 'u1',
      parentTurnId: undefined,
    })
  })

  it('takes the previous user message as the parent', () => {
    expect(
      resolveTurnIdentity([user('u1'), assistant('a1'), user('u2')]),
    ).toEqual({ turnId: 'u2', parentTurnId: 'u1' })
  })

  it('ignores assistant and tool messages when counting turns', () => {
    const messages = [
      user('u1'),
      assistant('a1'),
      { role: 'tool', id: 't1' } as unknown as ChatMessage,
      assistant('a2'),
      user('u2'),
    ]
    expect(resolveTurnIdentity(messages)).toEqual({
      turnId: 'u2',
      parentTurnId: 'u1',
    })
  })

  it('keeps the same identity when a turn is regenerated', () => {
    // Regenerating does not add a user message, so both ids are unchanged —
    // which is what lets the provider fork at the parent's anchor instead of
    // appending a second answer to the native transcript.
    const before = [user('u1'), assistant('a1'), user('u2'), assistant('a2')]
    const after = [user('u1'), assistant('a1'), user('u2')]
    expect(resolveTurnIdentity(after)).toEqual(resolveTurnIdentity(before))
  })
})
