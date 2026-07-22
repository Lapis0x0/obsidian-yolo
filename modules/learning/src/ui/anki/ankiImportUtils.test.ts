import type { AnkiImportPlan } from '../../anki/import'

import {
  MAX_ANKI_PACKAGE_BYTES,
  formatByteSize,
  summarizeAnkiImport,
  validateAnkiImportFiles,
} from './ankiImportUtils'

const file = (name: string, size: number) => ({ name, size }) as File

describe('Anki import UI helpers', () => {
  it('accepts one non-empty APKG case-insensitively', () => {
    expect(validateAnkiImportFiles([file('Deck.APKG', 1)])).toBeNull()
  })

  it.each([
    [[], 'multiple'],
    [[file('deck.apkg', 1), file('other.apkg', 1)], 'multiple'],
    [[file('deck.zip', 1)], 'extension'],
    [[file('deck.apkg', 0)], 'empty'],
    [[file('deck.apkg', MAX_ANKI_PACKAGE_BYTES + 1)], 'tooLarge'],
  ] as const)('validates %p as %s', (files, error) => {
    expect(validateAnkiImportFiles(files)).toBe(error)
  })

  it('summarizes preview data without retaining binary assets', () => {
    const plan = {
      projectSlug: 'deck',
      chapters: [{ slug: 'chapter' }],
      cardCount: 2,
      srsState: { cards: { one: {} }, suspended: ['two'] },
      assets: [{ bytes: new Uint8Array(2048) }],
      warnings: ['skipped'],
    } as unknown as AnkiImportPlan
    expect(summarizeAnkiImport(plan)).toEqual({
      chapterCount: 1,
      cardCount: 2,
      historyCount: 1,
      suspendedCount: 1,
      mediaCount: 1,
      mediaBytes: 2048,
      warningCount: 1,
      chapterPaths: ['deck/chapter'],
    })
    expect(formatByteSize(2048)).toBe('2.0 KB')
  })
})
