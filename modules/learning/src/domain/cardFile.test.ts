import { LearningCardFileStore, parseCardFile } from './cardFile'
import type { LearningVaultReadApi } from './learningVaultReadApi'
import type {
  LearningVaultCasWriteApi,
  LearningVaultFileSnapshot,
} from './learningVaultWriteApi'

const CARD = '## A <!--card:aaaaaaaa kp:11111111-->\n\nfront A\n\n---\n\nback A'

describe('cardFile domain', () => {
  it('strictly parses cards with exact source positions', () => {
    const content = `---\ntitle: Cards\n---\n\n${CARD}\n`
    const result = parseCardFile(content, 'p/cards.md')

    expect(result.complete).toBe(true)
    expect(result.cards[0]).toMatchObject({
      cardUuid: 'aaaaaaaa',
      kpUuid: '11111111',
      front: 'front A',
      back: 'back A',
      startOffset: content.indexOf(CARD),
    })
  })

  it('updates through compare-and-swap snapshots', async () => {
    let current: LearningVaultFileSnapshot = {
      path: 'p/cards.md',
      content: CARD,
      identity: Object.freeze({ receipt: 'initial' }),
    }
    const replaceTextIfUnchanged = jest.fn(
      async (expected: LearningVaultFileSnapshot, content: string) => {
        if (expected !== current) return null
        current = {
          path: expected.path,
          content,
          identity: Object.freeze({ receipt: 'updated' }),
        }
        return current
      },
    )
    const writer: LearningVaultCasWriteApi = {
      readTextSnapshot: async () => current,
      createTextIfAbsent: async () => null,
      replaceTextIfUnchanged,
      revertOwnedCreatedTextIfUnchanged: async () => null,
    }
    const vault: LearningVaultReadApi = {
      getEntry: () => null,
      listChildren: () => [],
      listMarkdownFiles: () => [],
      exists: async () => false,
      readText: async () => '',
      readBinary: async () => new ArrayBuffer(0),
      onCreate: () => () => undefined,
      onModify: () => () => undefined,
      onDelete: () => () => undefined,
      onRename: () => () => undefined,
    }

    await new LearningCardFileStore(vault, writer).updateCard(
      'p/cards.md',
      'aaaaaaaa',
      { front: 'changed', back: 'answer' },
    )

    expect(replaceTextIfUnchanged).toHaveBeenCalledTimes(1)
    expect(current.content).toContain('changed\n\n---\n\nanswer')
  })
})
