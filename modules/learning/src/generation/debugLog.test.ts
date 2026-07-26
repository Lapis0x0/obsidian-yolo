import { emitCardFailureDiagnostics } from './debugLog'

describe('emitCardFailureDiagnostics', () => {
  let warn: jest.SpyInstance

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warn.mockRestore()
  })

  it('reports counts for a stream that produced no parseable block', () => {
    emitCardFailureDiagnostics({
      chapterTitle: 'Integer Remainders',
      reason: 'no-drafts',
      publishedCards: 0,
      discardedBlocks: 3,
      inspectedLength: 812,
      inspectedSource: 'stream-output',
    })

    const message = String(warn.mock.calls[0][0])
    expect(message).toContain('Integer Remainders')
    expect(message).toContain('without producing a parseable card block')
    expect(message).toContain('published: 0')
    expect(message).toContain('discarded: 3')
    expect(message).toContain('stream-output length: 812')
  })

  it('lists card identifiers and validation labels when every card is rejected', () => {
    emitCardFailureDiagnostics({
      chapterTitle: 'Modulo Basics',
      reason: 'no-valid-cards',
      publishedCards: 2,
      discardedBlocks: 2,
      inspectedLength: 480,
      inspectedSource: 'cards-file',
      rejected: [{ cardUuid: 'aaaaaaaa', errors: ['missing kp UUID'] }],
    })

    expect(String(warn.mock.calls[0][0])).toContain('every parsed card failed')
    expect(String(warn.mock.calls[0][0])).toContain('cards-file length: 480')
    expect(warn.mock.calls[1][1]).toEqual([
      { cardUuid: 'aaaaaaaa', errors: ['missing kp UUID'] },
    ])
  })

  it('never logs model output, card text, or knowledge content', () => {
    const secret = 'SENSITIVE-CARD-BODY'
    emitCardFailureDiagnostics({
      chapterTitle: 'Chapter',
      reason: 'no-drafts',
      publishedCards: 0,
      discardedBlocks: 1,
      inspectedLength: secret.length,
      inspectedSource: 'stream-output',
    })

    const logged = warn.mock.calls
      .map((call) =>
        call.map((part: unknown) => JSON.stringify(part)).join(' '),
      )
      .join('\n')
    expect(logged).not.toContain(secret)
  })
})
