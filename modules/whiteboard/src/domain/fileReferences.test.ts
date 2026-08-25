import { type Board, type NoteCard, type PdfCard, type TextCard, emptyBoard } from './fileFormat'
import { rewriteFileReferences } from './fileReferences'

function noteCard(id: string, file: string): NoteCard {
  return { id, type: 'note', x: 0, y: 0, w: 100, h: 100, file, extra: {} }
}

function pdfCard(id: string, file: string, page = 1): PdfCard {
  return { id, type: 'pdf', x: 0, y: 0, w: 100, h: 100, file, page, extra: {} }
}

function textCard(id: string, markdown = ''): TextCard {
  return { id, type: 'text', x: 0, y: 0, w: 100, h: 100, markdown, extra: {} }
}

function boardWith(cards: Board['cards']): Board {
  return { ...emptyBoard(), cards }
}

describe('rewriteFileReferences', () => {
  it('rewrites a matching note card file path', () => {
    const c1 = noteCard('c1', 'old/path.md')
    const board = boardWith([c1])
    const next = rewriteFileReferences(board, 'old/path.md', 'new/path.md')
    expect(next).not.toBeNull()
    expect(next?.cards[0]).toMatchObject({ file: 'new/path.md' })
  })

  it('rewrites a matching pdf card file path, preserving its page', () => {
    const c1 = pdfCard('c1', 'old/paper.pdf', 5)
    const board = boardWith([c1])
    const next = rewriteFileReferences(board, 'old/paper.pdf', 'new/paper.pdf')
    expect(next?.cards[0]).toMatchObject({ file: 'new/paper.pdf', page: 5 })
  })

  it('returns null when no card references the given path', () => {
    const board = boardWith([noteCard('c1', 'other.md')])
    expect(rewriteFileReferences(board, 'old.md', 'new.md')).toBeNull()
  })

  it('leaves untouched cards referentially unchanged', () => {
    const c1 = noteCard('c1', 'old.md')
    const c2 = noteCard('c2', 'unrelated.md')
    const t1 = textCard('t1')
    const board = boardWith([c1, c2, t1])
    const next = rewriteFileReferences(board, 'old.md', 'new.md')
    expect(next?.cards[1]).toBe(c2)
    expect(next?.cards[2]).toBe(t1)
    expect(next?.cards[0]).not.toBe(c1)
  })

  it('rewrites every card referencing the same old path', () => {
    const c1 = noteCard('c1', 'shared.md')
    const c2 = pdfCard('c2', 'shared.md')
    const board = boardWith([c1, c2])
    const next = rewriteFileReferences(board, 'shared.md', 'moved.md')
    expect(next?.cards[0]).toMatchObject({ file: 'moved.md' })
    expect(next?.cards[1]).toMatchObject({ file: 'moved.md' })
  })

  it('never matches a text card (it has no file field)', () => {
    const board = boardWith([textCard('t1')])
    expect(rewriteFileReferences(board, 'old.md', 'new.md')).toBeNull()
  })
})
