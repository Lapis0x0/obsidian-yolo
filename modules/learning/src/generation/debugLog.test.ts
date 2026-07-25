import { emitCardFailureDiagnostics } from './debugLog'

describe('emitCardFailureDiagnostics', () => {
  let warn: jest.SpyInstance

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warn.mockRestore()
  })

  it('reports why a chapter produced no parseable card blocks', () => {
    emitCardFailureDiagnostics({
      chapterTitle: 'Integer Remainders',
      reason: 'no-drafts',
      streamedDrafts: 0,
      discardedCount: 3,
      output: '## A card without an end marker',
    })

    const messages = warn.mock.calls.map((call) => String(call[0]))
    expect(messages[0]).toContain('Integer Remainders')
    expect(messages[0]).toContain('no parseable card blocks')
    expect(messages[0]).toContain('discarded: 3')
    expect(messages.join('\n')).toContain('## A card without an end marker')
  })

  it('lists per-card rejection reasons when validation drops every card', () => {
    emitCardFailureDiagnostics({
      chapterTitle: 'Modulo Basics',
      reason: 'no-valid-cards',
      streamedDrafts: 2,
      discardedCount: 2,
      invalid: [{ cardUuid: 'aaaaaaaa', errors: ['missing kp UUID'] }],
      output: '## Card\n\nfront\n\n---\n\nback',
    })

    expect(String(warn.mock.calls[0][0])).toContain('every parsed card failed')
    expect(warn.mock.calls[1][1]).toEqual([
      { cardUuid: 'aaaaaaaa', errors: ['missing kp UUID'] },
    ])
  })

  it('truncates very long model output', () => {
    emitCardFailureDiagnostics({
      chapterTitle: 'Long',
      reason: 'no-drafts',
      streamedDrafts: 0,
      discardedCount: 0,
      output: 'x'.repeat(5000),
    })

    const outputMessage = String(warn.mock.calls[warn.mock.calls.length - 1][0])
    expect(outputMessage).toContain('5000 chars')
    expect(outputMessage).toContain('chars)')
    expect(outputMessage.length).toBeLessThan(2000)
  })
})
