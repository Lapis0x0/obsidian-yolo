import { emitCardFailureDiagnostics } from './cardFailureDiagnostics'

describe('emitCardFailureDiagnostics', () => {
  let warn: jest.SpyInstance

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warn.mockRestore()
  })

  it('reports a stream that produced no complete card block', () => {
    emitCardFailureDiagnostics({
      chapterTitle: 'Integer Remainders',
      reason: 'no-usable-drafts',
      publishedCards: 0,
      discardedBlocks: 0,
      inspectedLength: 812,
      inspectedSource: 'stream-output',
      parserRejections: [],
    })

    const message = String(warn.mock.calls[0][0])
    expect(message).toContain('Integer Remainders')
    expect(message).toContain('without a complete card block')
    expect(message).toContain('published: 0')
    expect(message).toContain('discarded: 0')
    expect(message).toContain('stream-output length: 812')
  })

  it('lists the fixed parser rules that rejected completed blocks', () => {
    emitCardFailureDiagnostics({
      chapterTitle: 'Integer Remainders',
      reason: 'no-usable-drafts',
      publishedCards: 0,
      discardedBlocks: 1,
      inspectedLength: 812,
      inspectedSource: 'stream-output',
      parserRejections: [
        {
          blockIndex: 1,
          errors: ['kp:bbbbbbbb does not belong to this chapter'],
        },
      ],
    })

    expect(String(warn.mock.calls[0][0])).toContain(
      'every completed card block was rejected',
    )
    expect(warn.mock.calls[1][1]).toEqual([
      {
        blockIndex: 1,
        errors: ['kp:bbbbbbbb does not belong to this chapter'],
      },
    ])
  })

  it('lists card identifiers and validation labels when every card is rejected', () => {
    emitCardFailureDiagnostics({
      chapterTitle: 'Modulo Basics',
      reason: 'no-valid-cards',
      publishedCards: 2,
      discardedBlocks: 2,
      inspectedLength: 480,
      inspectedSource: 'cards-file',
      validationRejections: [
        { cardUuid: 'aaaaaaaa', errors: ['missing kp UUID'] },
      ],
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
      reason: 'no-usable-drafts',
      publishedCards: 0,
      discardedBlocks: 1,
      inspectedLength: secret.length,
      inspectedSource: 'stream-output',
      parserRejections: [{ blockIndex: 1, errors: ['missing title'] }],
    })

    const logged = warn.mock.calls
      .map((call) =>
        call.map((part: unknown) => JSON.stringify(part)).join(' '),
      )
      .join('\n')
    expect(logged).not.toContain(secret)
  })
})
