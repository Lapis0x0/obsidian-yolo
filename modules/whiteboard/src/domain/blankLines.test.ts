import { collapseBlankLines } from './blankLines'

describe('collapseBlankLines', () => {
  it('folds a run of blank and whitespace-only lines into one empty line', () => {
    const { markdown } = collapseBlankLines('A\n\n  \n\nB\n\n\n\nC\n\t　 \nD')
    expect(markdown).toBe('A\n\nB\n\nC\n\nD')
  })

  it('leaves text that already has single blank lines unchanged', () => {
    const source = '# Title\n\nA\n\n- one\n- two\n\nB'
    expect(collapseBlankLines(source).markdown).toBe(source)
  })

  it('drops blank lines at the start and the end', () => {
    expect(collapseBlankLines('\n  \nA\n\nB\n\n \n').markdown).toBe('A\n\nB')
  })

  it('collapses text holding nothing but blank lines to the empty string', () => {
    expect(collapseBlankLines('  \n\n\t\n').markdown).toBe('')
  })

  it('keeps every line inside a fenced code block', () => {
    const source = 'A\n\n\n```\nx\n\n\n  \ny\n```\n\n\nB'
    expect(collapseBlankLines(source).markdown).toBe(
      'A\n\n```\nx\n\n\n  \ny\n```\n\nB',
    )
  })

  it('closes a fence only with the marker that opened it', () => {
    const source = '~~~\n```\n\n\n~~~\n\n\nB'
    expect(collapseBlankLines(source).markdown).toBe('~~~\n```\n\n\n~~~\n\nB')
  })

  it('keeps an unterminated fence intact to the end', () => {
    const source = 'A\n\n```\nx\n\n\n'
    expect(collapseBlankLines(source).markdown).toBe(source)
  })

  it('does not touch whitespace on lines that have content', () => {
    const source = 'hard break  \nnext\n\n    indented'
    expect(collapseBlankLines(source).markdown).toBe(source)
  })

  describe('mapLine', () => {
    // 0 A · 1 '' · 2 '  ' · 3 '' · 4 B · 5 '' · 6 C
    const { mapLine } = collapseBlankLines('A\n\n  \n\nB\n\nC')
    // collapsed: 0 A · 1 '' · 2 B · 3 '' · 4 C

    it('moves a surviving line by the lines folded above it', () => {
      expect(mapLine(0)).toBe(0)
      expect(mapLine(4)).toBe(2)
      expect(mapLine(6)).toBe(4)
    })

    it('keeps the part of a line scrolled past', () => {
      expect(mapLine(4.5)).toBe(2.5)
    })

    it('lands a folded blank line on the one its run became', () => {
      expect(mapLine(1)).toBe(1)
      expect(mapLine(2)).toBe(1)
      expect(mapLine(3)).toBe(1)
    })

    it('clamps to the text it maps into', () => {
      expect(mapLine(-1)).toBe(0)
      expect(mapLine(Number.NaN)).toBe(0)
      expect(mapLine(99)).toBe(4)
    })

    it('puts leading and trailing blank lines on the nearest block', () => {
      const folded = collapseBlankLines('\n\nA\n\nB\n\n\n')
      // collapsed: 0 A · 1 '' · 2 B
      expect(folded.mapLine(1)).toBe(0)
      expect(folded.mapLine(2)).toBe(0)
      expect(folded.mapLine(6)).toBe(2)
    })
  })
})
