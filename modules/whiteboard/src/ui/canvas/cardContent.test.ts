import type { BoardNode } from '../../domain/fileFormat'
import { cardMarkdownWindow } from '../lod'

import { clippedCardMarkdown } from './cardContent'

const long = Array.from({ length: 400 }, (_, i) => `line ${i}\n`).join('\n')

const text = (fields: Partial<BoardNode> = {}): BoardNode =>
  ({
    id: 'a',
    type: 'text',
    x: 0,
    y: 0,
    w: 300,
    h: 200,
    text: long,
    extra: {},
    ...fields,
  }) as BoardNode

describe('clippedCardMarkdown', () => {
  it('shows a card as much as its height shows, from where it starts', () => {
    const node = text({ startLine: 40 } as Partial<BoardNode>)
    expect(clippedCardMarkdown(node, long)).toBe(
      cardMarkdownWindow(long, 200, 40),
    )
    expect(clippedCardMarkdown(node, long).length).toBeLessThan(long.length)
  })

  it('shows bare text all of it', () => {
    const node = text({ plain: true } as Partial<BoardNode>)
    expect(clippedCardMarkdown(node, long)).toBe(long)
  })
})
