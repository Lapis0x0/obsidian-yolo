import type { BoardNode } from '../../domain/fileFormat'

import { cardSignature, isCardPictured } from './cardSignature'

const text = (fields: Partial<BoardNode> = {}): BoardNode =>
  ({
    id: 'a',
    type: 'text',
    x: 0,
    y: 0,
    w: 300,
    h: 200,
    text: '# Title\n\nBody',
    extra: {},
    ...fields,
  }) as BoardNode

const note = (fields: Partial<BoardNode> = {}): BoardNode =>
  ({
    id: 'b',
    type: 'file',
    x: 0,
    y: 0,
    w: 300,
    h: 200,
    file: 'Notes/a.md',
    extra: {},
    ...fields,
  }) as BoardNode

describe('cardSignature', () => {
  it('pictures text, bare text and notes only', () => {
    expect(isCardPictured(text())).toBe(true)
    expect(isCardPictured(text({ plain: true } as Partial<BoardNode>))).toBe(
      true,
    )
    expect(isCardPictured(note())).toBe(true)
    expect(isCardPictured(note({ file: 'a.png' } as Partial<BoardNode>))).toBe(
      false,
    )
    expect(isCardPictured(note({ file: 'a.pdf' } as Partial<BoardNode>))).toBe(
      false,
    )
    expect(
      cardSignature(note({ file: 'a.png' } as Partial<BoardNode>), 1),
    ).toBe(null)
  })

  it('changes with what changes how the content looks', () => {
    const base = cardSignature(text(), null)
    expect(cardSignature(text(), null)).toBe(base)
    for (const change of [
      { text: 'Other' },
      { w: 301 },
      { h: 201 },
      { startLine: 3 },
      { plain: true },
    ] as Partial<BoardNode>[]) {
      expect(cardSignature(text(change), null)).not.toBe(base)
    }
  })

  it('leaves a card’s colour to its frame, but not bare text’s', () => {
    expect(
      cardSignature(text({ color: '1' } as Partial<BoardNode>), null),
    ).toBe(cardSignature(text(), null))
    const plain = { plain: true } as Partial<BoardNode>
    expect(
      cardSignature(text({ ...plain, color: '1' } as Partial<BoardNode>), null),
    ).not.toBe(cardSignature(text(plain), null))
  })

  it('follows a note’s file', () => {
    expect(cardSignature(note(), 1)).not.toBe(cardSignature(note(), 2))
    expect(cardSignature(note(), null)).toBeNull()
    // Where a note is on the board is not how it looks.
    expect(cardSignature(note({ x: 50 } as Partial<BoardNode>), 1)).toBe(
      cardSignature(note(), 1),
    )
  })
})
