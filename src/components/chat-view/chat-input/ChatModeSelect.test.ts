import {
  CHAT_MODES,
  CLAUDE_CODE_CHAT_MODES,
  CODEX_CHAT_MODES,
  shouldShowYoloToggle,
} from './ChatModeSelect'

describe('ChatModeSelect runtime options', () => {
  it('exposes the intended modes for each runtime', () => {
    expect(CHAT_MODES).toEqual(['ask', 'agent'])
    expect(CLAUDE_CODE_CHAT_MODES).toEqual(['agent', 'plan'])
    expect(CODEX_CHAT_MODES).toEqual(['agent'])
  })

  it('hides the YOLO switch while Plan is active', () => {
    expect(shouldShowYoloToggle(CLAUDE_CODE_CHAT_MODES, 'agent')).toBe(true)
    expect(shouldShowYoloToggle(CLAUDE_CODE_CHAT_MODES, 'plan')).toBe(false)
  })
})
