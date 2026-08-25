import type { NoteCard, PdfCard, TextCard } from '../domain/fileFormat'

import { basenameWithoutExtension, degradedCardTitle, isDegradedScale } from './lod'

describe('isDegradedScale', () => {
  it('is true below the threshold', () => {
    expect(isDegradedScale(0.2, 0.35)).toBe(true)
  })

  it('is false at or above the threshold', () => {
    expect(isDegradedScale(0.35, 0.35)).toBe(false)
    expect(isDegradedScale(1, 0.35)).toBe(false)
  })
})

describe('basenameWithoutExtension', () => {
  it('strips a vault-relative directory path and extension', () => {
    expect(basenameWithoutExtension('Cards/concept a.md')).toBe('concept a')
  })

  it('handles a bare filename with no directory', () => {
    expect(basenameWithoutExtension('foo.pdf')).toBe('foo')
  })

  it('leaves a leading dot (dotfile) alone rather than treating it as the extension', () => {
    expect(basenameWithoutExtension('.gitignore')).toBe('.gitignore')
  })

  it('leaves a file with no extension alone', () => {
    expect(basenameWithoutExtension('Cards/README')).toBe('README')
  })
})

function noteCard(file: string): NoteCard {
  return { id: 'c1', type: 'note', x: 0, y: 0, w: 100, h: 100, file, extra: {} }
}

function pdfCard(file: string): PdfCard {
  return { id: 'c2', type: 'pdf', x: 0, y: 0, w: 100, h: 100, file, page: 1, extra: {} }
}

function textCard(markdown: string): TextCard {
  return { id: 'c3', type: 'text', x: 0, y: 0, w: 100, h: 100, markdown, extra: {} }
}

describe('degradedCardTitle', () => {
  it('shows a note card basename', () => {
    expect(degradedCardTitle(noteCard('Cards/概念A.md'))).toBe('概念A')
  })

  it('shows a pdf card basename', () => {
    expect(degradedCardTitle(pdfCard('papers/foo.pdf'))).toBe('foo')
  })

  it('shows a text card first line, trimmed', () => {
    expect(degradedCardTitle(textCard('  hello world  \nsecond line'))).toBe('hello world')
  })

  it('shows the whole markdown when it has no newline', () => {
    expect(degradedCardTitle(textCard('single line'))).toBe('single line')
  })

  it('truncates a long text card first line', () => {
    const long = 'x'.repeat(100)
    const title = degradedCardTitle(textCard(long))
    expect(title.length).toBe(60)
    expect(title.endsWith('…')).toBe(true)
  })
})
