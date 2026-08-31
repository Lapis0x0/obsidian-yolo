import type { ProviderSession } from '../../types/provider-session.types'

import { resolveResumeTarget } from './claudeOAuthProvider'

const session = (
  overrides: Partial<ProviderSession> = {},
): ProviderSession => ({
  providerId: 'claude-oauth',
  nativeSessionId: 'native-1',
  anchors: { 'turn-1': 'uuid-1', 'turn-2': 'uuid-2' },
  tipTurnId: 'turn-2',
  ...overrides,
})

describe('resolveResumeTarget', () => {
  it('opens a new session when there is nothing to resume', () => {
    expect(resolveResumeTarget(undefined, 'turn-2')).toEqual({})
  })

  it('continues the session when the turn follows its tip', () => {
    expect(resolveResumeTarget(session(), 'turn-2')).toEqual({
      resume: 'native-1',
    })
  })

  it('forks at the parent anchor when the conversation branched', () => {
    // Editing or regenerating turn-2 makes turn-1 the parent again, while the
    // native transcript still ends at turn-2.
    expect(resolveResumeTarget(session(), 'turn-1')).toEqual({
      resume: 'native-1',
      resumeAt: 'uuid-1',
    })
  })

  it('starts fresh when the parent turn has no anchor', () => {
    expect(resolveResumeTarget(session(), 'turn-unknown')).toEqual({})
  })

  it('starts fresh when a stored session has no tip and no matching anchor', () => {
    expect(
      resolveResumeTarget(session({ tipTurnId: undefined }), 'turn-9'),
    ).toEqual({})
  })

  it('continues a session whose tip is unset for a conversation-opening turn', () => {
    expect(
      resolveResumeTarget(session({ tipTurnId: undefined }), undefined),
    ).toEqual({ resume: 'native-1' })
  })
})
