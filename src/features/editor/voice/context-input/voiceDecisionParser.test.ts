import { parseVoiceEditorDecision } from './voiceDecisionParser'

describe('parseVoiceEditorDecision', () => {
  it('parses strict JSON decisions', () => {
    expect(
      parseVoiceEditorDecision(
        '{"action":"insert_at_cursor","text":"Hello","notice":"Done"}',
        { hasSelection: false },
      ),
    ).toEqual({
      action: 'insert_at_cursor',
      text: 'Hello',
      notice: 'Done',
    })
  })

  it('recovers a JSON object from a markdown fence with surrounding text', () => {
    expect(
      parseVoiceEditorDecision(
        '```json\n{"action":"replace_selection","text":"替换"}\n```',
        { hasSelection: true },
      ),
    ).toEqual({ action: 'replace_selection', text: '替换' })
  })

  it('demotes selection-relative actions when selection no longer exists', () => {
    expect(
      parseVoiceEditorDecision(
        '{"action":"insert_after_selection","text":"继续"}',
        { hasSelection: false },
      ),
    ).toEqual({ action: 'insert_at_cursor', text: '继续' })
  })

  it('falls back to plain cursor insertion for non-JSON prose', () => {
    expect(
      parseVoiceEditorDecision(' just insert this ', { hasSelection: false }),
    ).toEqual({
      action: 'insert_at_cursor',
      text: 'just insert this',
    })
  })

  it('refuses malformed JSON envelopes instead of inserting raw JSON', () => {
    expect(
      parseVoiceEditorDecision(
        '{"action":"insert_at_cursor","text":"missing brace"',
        { hasSelection: false },
      ),
    ).toEqual({
      action: 'insert_at_cursor',
      text: '',
      malformed: true,
    })
  })

  it('refuses unknown actions inside otherwise valid JSON envelopes', () => {
    expect(
      parseVoiceEditorDecision('{"action":"delete_document","text":"nope"}', {
        hasSelection: true,
      }),
    ).toEqual({
      action: 'insert_at_cursor',
      text: '',
      malformed: true,
    })
  })
})
