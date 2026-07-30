import { isCliSessionRef } from './types'

describe('CLI runtime conversation references', () => {
  it('discriminates YOLO conversations from native CLI sessions', () => {
    expect(
      isCliSessionRef({ runtimeId: 'yolo', conversationId: 'chat-1' }),
    ).toBe(false)
    expect(
      isCliSessionRef({
        runtimeId: 'claude-code',
        nativeSessionId: 'session-1',
      }),
    ).toBe(true)
  })
})
