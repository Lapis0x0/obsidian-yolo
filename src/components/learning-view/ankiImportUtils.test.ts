import {
  MAX_ANKI_PACKAGE_BYTES,
  formatByteSize,
  summarizeAnkiImport,
  validateAnkiImportFiles,
} from './ankiImportUtils'

const file = (name: string, size: number) => ({ name, size }) as unknown as File

describe('validateAnkiImportFiles', () => {
  it('accepts one APKG within the UI limit', () => {
    expect(validateAnkiImportFiles([file('Deck.APKG', 1024)])).toBeNull()
  })

  it.each([
    [[], 'multiple'],
    [[file('a.apkg', 1), file('b.apkg', 1)], 'multiple'],
    [[file('deck.zip', 1)], 'extension'],
    [[file('deck.apkg', 0)], 'empty'],
    [[file('deck.apkg', MAX_ANKI_PACKAGE_BYTES + 1)], 'tooLarge'],
  ] as const)('rejects invalid files', (files, error) => {
    expect(validateAnkiImportFiles(files)).toBe(error)
  })
})

describe('summarizeAnkiImport', () => {
  it('summarizes preview counts and chapter paths', () => {
    const plan = {
      projectSlug: 'biology',
      chapters: [
        { slug: 'cells', cards: [] },
        { slug: 'genes', cards: [] },
      ],
      cardCount: 12,
      srsState: { cards: { a: {}, b: {} }, suspended: ['b'] },
      assets: [{ bytes: new Uint8Array(1536) }],
      warnings: ['Skipped an unsupported template'],
    }
    expect(summarizeAnkiImport(plan as never)).toEqual({
      chapterCount: 2,
      cardCount: 12,
      historyCount: 2,
      suspendedCount: 1,
      mediaCount: 1,
      mediaBytes: 1536,
      warningCount: 1,
      chapterPaths: ['biology/cells', 'biology/genes'],
    })
    expect(formatByteSize(1536)).toBe('1.5 KB')
  })
})
