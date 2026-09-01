import type {
  FileNode,
  GroupNode,
  LinkNode,
  TextNode,
} from '../domain/fileFormat'

import { OVERVIEW_RESTORE_SCALE, OVERVIEW_SCALE_THRESHOLD } from './constants'
import {
  blockStartLine,
  cardMarkdownWindow,
  nextOverviewState,
  nodeTitleText,
} from './lod'

describe('nextOverviewState', () => {
  const band = { enter: 0.35, restore: 0.42 }

  it('hands the board to the canvas once the scale drops below the enter threshold', () => {
    expect(nextOverviewState(0.2, false, band)).toBe(true)
  })

  it('keeps the board in the DOM at or above the enter threshold', () => {
    expect(nextOverviewState(0.35, false, band)).toBe(false)
    expect(nextOverviewState(1, false, band)).toBe(false)
  })

  it('stays on the canvas inside the band — a scale that only just cleared the enter threshold does not remount every card', () => {
    expect(nextOverviewState(0.36, true, band)).toBe(true)
    expect(nextOverviewState(0.41, true, band)).toBe(true)
  })

  it('restores once the scale clears the far side of the band', () => {
    expect(nextOverviewState(0.42, true, band)).toBe(false)
    expect(nextOverviewState(1, true, band)).toBe(false)
  })

  it('is driven by a band the constants actually leave open', () => {
    expect(OVERVIEW_RESTORE_SCALE).toBeGreaterThan(OVERVIEW_SCALE_THRESHOLD)
  })
})

function fileNode(file: string): FileNode {
  return { id: 'c1', type: 'file', x: 0, y: 0, w: 100, h: 100, file, extra: {} }
}

function textCard(text: string): TextNode {
  return { id: 'c3', type: 'text', x: 0, y: 0, w: 100, h: 100, text, extra: {} }
}

function groupNode(label?: string): GroupNode {
  return {
    id: 'g1',
    type: 'group',
    x: 0,
    y: 0,
    w: 400,
    h: 400,
    ...(label === undefined ? {} : { label }),
    extra: {},
  }
}

function linkNode(url: string): LinkNode {
  return { id: 'l1', type: 'link', x: 0, y: 0, w: 400, h: 300, url, extra: {} }
}

describe('nodeTitleText', () => {
  it('shows a link node URL, truncated like any other title', () => {
    expect(nodeTitleText(linkNode('https://example.com'))).toBe(
      'https://example.com',
    )
    const long = `https://example.com/${'x'.repeat(100)}`
    expect(nodeTitleText(linkNode(long))).toHaveLength(60)
  })

  it('shows a markdown file node basename', () => {
    expect(nodeTitleText(fileNode('Cards/概念A.md'))).toBe('概念A')
  })

  it('shows any other file node basename the same way', () => {
    expect(nodeTitleText(fileNode('papers/foo.pdf'))).toBe('foo')
  })

  it('shows a group label, and nothing for an unlabelled group', () => {
    expect(nodeTitleText(groupNode('研究'))).toBe('研究')
    expect(nodeTitleText(groupNode())).toBe('')
  })

  it('shows a text node first line, trimmed', () => {
    expect(nodeTitleText(textCard('  hello world  \nsecond line'))).toBe(
      'hello world',
    )
  })

  it('shows the whole text when it has no newline', () => {
    expect(nodeTitleText(textCard('single line'))).toBe('single line')
  })

  it('drops a leading heading marker — the line is shown as a title, not as markdown', () => {
    expect(nodeTitleText(textCard('# 测试\n\nbody'))).toBe('测试')
    expect(nodeTitleText(textCard('###### deep'))).toBe('deep')
  })

  it('keeps markers that are not headings, and a hash that is not one', () => {
    expect(nodeTitleText(textCard('- 买牛奶'))).toBe('- 买牛奶')
    expect(nodeTitleText(textCard('#tag 起头'))).toBe('#tag 起头')
  })

  it('truncates a long text node first line', () => {
    const long = 'x'.repeat(100)
    const title = nodeTitleText(textCard(long))
    expect(title.length).toBe(60)
    expect(title.endsWith('…')).toBe(true)
  })
})

describe('cardMarkdownWindow', () => {
  const lines = (n: number, prefix = 'line'): string =>
    Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join('\n')

  it('gives a short note back whole', () => {
    const markdown = lines(3)
    expect(cardMarkdownWindow(markdown, 200)).toBe(markdown)
  })

  it('bounds a long note by the card height', () => {
    // 200px / 16px + 4 = 17 lines.
    expect(cardMarkdownWindow(lines(500), 200).split('\n')).toHaveLength(17)
    expect(cardMarkdownWindow(lines(500), 400).split('\n')).toHaveLength(29)
  })

  it('grows the window with the card, which is the point', () => {
    const markdown = lines(500)
    const short = cardMarkdownWindow(markdown, 200)
    const tall = cardMarkdownWindow(markdown, 800)
    expect(tall.startsWith(short)).toBe(true)
    expect(tall.length).toBeGreaterThan(short.length)
  })

  it('keeps blank lines without spending budget on them', () => {
    // Every other line blank: the budget still buys 17 lines of content, so
    // a note written with paragraph breaks does not arrive half empty.
    const spaced = Array.from({ length: 500 }, (_, i) => `line ${i}\n`).join(
      '\n',
    )
    const window = cardMarkdownWindow(spaced, 200)
    expect(
      window.split('\n').filter((line: string) => line !== ''),
    ).toHaveLength(17)
  })

  it('cuts on a line boundary when one pathological line blows the cap', () => {
    const markdown = `# title\n${'x'.repeat(9000)}\ntail`
    const window = cardMarkdownWindow(markdown, 200)
    expect(window).toBe('# title')
  })

  it('never returns more than the character cap', () => {
    const markdown = lines(500, 'x'.repeat(300))
    expect(cardMarkdownWindow(markdown, 4000).length).toBeLessThanOrEqual(4000)
  })

  it('treats a zero-height card as the smallest budget rather than throwing', () => {
    expect(cardMarkdownWindow(lines(500), 0).split('\n')).toHaveLength(4)
  })

  it('starts the window at the requested block', () => {
    const markdown = 'alpha\n\nbeta\n\ngamma\n\ndelta'
    expect(cardMarkdownWindow(markdown, 200, 4)).toBe('gamma\n\ndelta')
  })

  it('backs a start inside a block up to where that block begins', () => {
    const markdown = 'alpha\n\nbeta one\nbeta two\nbeta three\n\ngamma'
    expect(cardMarkdownWindow(markdown, 200, 4)).toBe(
      'beta one\nbeta two\nbeta three\n\ngamma',
    )
  })

  it('never begins inside a fenced block, where the closing fence would open one', () => {
    const markdown = [
      'intro',
      '',
      '```js',
      'const a = 1',
      'const b = 2',
      '```',
      '',
      'tail',
    ].join('\n')
    // Line 4 is inside the fence; starting there would leave "```" reading as
    // an opening fence and render everything after it as code.
    expect(cardMarkdownWindow(markdown, 400, 4)).toBe(
      '```js\nconst a = 1\nconst b = 2\n```\n\ntail',
    )
  })

  it('does not let a blank line inside a fence look like a block boundary', () => {
    const markdown = ['~~~', 'a', '', 'b', '~~~', '', 'after'].join('\n')
    expect(cardMarkdownWindow(markdown, 400, 3)).toBe(markdown)
  })

  it('reads a fence closed only by its own marker', () => {
    const markdown = ['```', 'a', '~~~', 'b', '```', '', 'after'].join('\n')
    expect(cardMarkdownWindow(markdown, 400, 3)).toBe(markdown)
  })

  it('ignores a window past the end of the note', () => {
    expect(cardMarkdownWindow('alpha\n\nbeta', 200, 999)).toBe('beta')
  })
})

// The quantum a reading window moves in. Applied where the window is written
// (canvas.ts's `boardWithSnappedWindow`) so that the card's clipped render and
// its scrollable preview are asked for the same place.
describe('blockStartLine', () => {
  const markdown = [
    '# title', // 0
    '', // 1
    'first paragraph', // 2
    'still the first', // 3
    '', // 4
    '```js', // 5
    'const a = 1', // 6
    '', // 7
    '```', // 8
    '', // 9
    'last paragraph', // 10
  ].join('\n')

  it('backs up to where the block the line is in starts', () => {
    expect(blockStartLine(markdown, 3)).toBe(2)
    expect(blockStartLine(markdown, 10)).toBe(10)
  })

  it('never lands inside a fence, blank line or not', () => {
    expect(blockStartLine(markdown, 6)).toBe(5)
    expect(blockStartLine(markdown, 7)).toBe(5)
    expect(blockStartLine(markdown, 8)).toBe(5)
  })

  it('is idempotent — a window already snapped stays put', () => {
    for (let line = 0; line <= 10; line += 1) {
      const snapped = blockStartLine(markdown, line)
      expect(blockStartLine(markdown, snapped)).toBe(snapped)
    }
  })

  it('drops the fraction a scroll position carries', () => {
    expect(blockStartLine(markdown, 3.75)).toBe(2)
  })

  it('answers the top for the top, and for nothing sensible', () => {
    expect(blockStartLine(markdown, 0)).toBe(0)
    expect(blockStartLine(markdown, 1)).toBe(0)
    expect(blockStartLine(markdown, -4)).toBe(0)
    expect(blockStartLine(markdown, Number.NaN)).toBe(0)
  })

  it('clamps a line past the end of the note to its last block', () => {
    expect(blockStartLine(markdown, 999)).toBe(10)
  })
})
