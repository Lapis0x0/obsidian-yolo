import { breakLines } from './breaking'
import { layoutCard } from './layout'
import {
  BOLD,
  CODE,
  HIGHLIGHT,
  ITALIC,
  type Inline,
  LINK,
  STRIKE,
  TAG,
} from './model'
import { parseCard } from './parse'
import type { TextStyle, TypesetTokens } from './tokens'

// Latin 8 units a character, CJK 16: enough to reason about where lines
// break without a font.
const measure = (text: string): number =>
  Array.from(text).reduce(
    (sum, ch) => sum + ((ch.codePointAt(0) ?? 0) > 0x2e80 ? 16 : 8),
    0,
  )
const plain = () => ({ font: 'f', padX: 0 })
const texts = (lines: ReturnType<typeof breakLines>) =>
  lines.map((line) => line.pieces.map((p) => p.text).join(''))

describe('parseCard', () => {
  test('drops front matter and spaces blocks by the blank lines after them', () => {
    const sections = parseCard('---\na: 1\n---\n# Title\nbody\n\n\nnext')
    expect(sections.map((s) => s.block.kind)).toEqual([
      'heading',
      'paragraph',
      'paragraph',
    ])
    expect(sections.map((s) => s.blankAfter).slice(0, 2)).toEqual([0, 2])
  })

  test('reads Obsidian syntax CommonMark leaves as text', () => {
    const [section] = parseCard(
      'a **b** *c* ~~d~~ `e` [[note|alias]] [x](http://x) #tag #123 ==f **g** h== z',
    )
    const block = section.block
    if (block.kind !== 'paragraph') throw new Error(block.kind)
    const find = (text: string): Inline | undefined =>
      block.inlines.find((i) => i.text.includes(text))
    expect(find('b')?.flags).toBe(BOLD)
    expect(find('c')?.flags).toBe(ITALIC)
    expect(find('d')?.flags).toBe(STRIKE)
    expect(find('e')?.flags).toBe(CODE)
    expect(find('alias')?.flags).toBe(LINK)
    expect(find('x')?.flags).toBe(LINK)
    expect(find('#tag')?.flags).toBe(TAG)
    expect(find('#123')?.flags ?? 0).toBe(0)
    expect(find('f ')?.flags).toBe(HIGHLIGHT)
    expect(block.inlines.find((i) => i.text === 'g')?.flags).toBe(
      HIGHLIGHT | BOLD,
    )
    expect(find(' z')?.flags).toBe(0)
  })

  test('a soft line break is a line break', () => {
    const [section] = parseCard('one\ntwo')
    if (section.block.kind !== 'paragraph') throw new Error('paragraph')
    expect(section.block.inlines.map((i) => i.text)).toEqual([
      'one',
      '\n',
      'two',
    ])
  })

  test('callouts, quotes, tasks, numbered lists and lone embeds', () => {
    const sections = parseCard(
      '> [!Tip] Title here\n> body\n\n> quoted\n\n- [ ] todo\n- [x] done\n\n3. three\n\n![[pic.png]]',
    )
    const [callout, quote, tasks, numbered, embed] = sections.map(
      (s) => s.block,
    )
    expect(callout).toMatchObject({ kind: 'callout', type: 'tip' })
    if (callout.kind === 'callout') {
      expect(callout.title.map((i) => i.text).join('')).toBe('Title here')
      expect(callout.children[0].block.kind).toBe('paragraph')
    }
    expect(quote.kind).toBe('quote')
    if (tasks.kind !== 'list') throw new Error(tasks.kind)
    expect(tasks.items.map((i) => i.checked)).toEqual([false, true])
    expect(numbered).toMatchObject({ kind: 'list', ordered: true, start: 3 })
    expect(embed).toEqual({ kind: 'embed', target: 'pic.png' })
  })
})

describe('breakLines', () => {
  test('breaks at spaces and drops the spaces it breaks at', () => {
    const lines = breakLines(
      [{ text: 'aaa bbb ccc', flags: 0 }],
      60,
      plain,
      measure,
    )
    expect(texts(lines)).toEqual(['aaa bbb', 'ccc'])
  })

  test('breaks between CJK characters, never before a closing mark', () => {
    // Three characters fit; the comma would start the second line, so the
    // character before it goes down with it.
    const lines = breakLines(
      [{ text: '一二三，四', flags: 0 }],
      48,
      plain,
      measure,
    )
    expect(texts(lines)).toEqual(['一二', '三，四'])
  })

  test('never after an opening mark', () => {
    const lines = breakLines(
      [{ text: '一二（三）', flags: 0 }],
      48,
      plain,
      measure,
    )
    expect(texts(lines)[0]).toBe('一二')
  })

  test('cuts a word only when it is wider than the line', () => {
    const lines = breakLines(
      [{ text: 'ab abcdefghij', flags: 0 }],
      40,
      plain,
      measure,
    )
    expect(texts(lines)).toEqual(['ab', 'abcde', 'fghij'])
  })

  test('honours hard breaks, and gives a pill its padding', () => {
    const lines = breakLines(
      [
        { text: 'a', flags: 0 },
        { text: '\n', flags: 0 },
        { text: 'code', flags: CODE },
      ],
      200,
      (flags) => ({ font: 'f', padX: flags & CODE ? 4 : 0 }),
      measure,
    )
    expect(texts(lines)).toEqual(['a', 'code'])
    expect(lines[1].pieces[0]).toMatchObject({ width: 32 + 8, padLeft: 4 })
  })
})

describe('layoutCard', () => {
  const style = (size: number, lineHeight: number): TextStyle => ({
    family: 'f',
    size,
    weight: 400,
    italic: false,
    color: 'black',
    lineHeight,
  })
  const body = style(15, 24)
  const tokens: TypesetTokens = {
    inset: { top: 17, right: 21, bottom: 17, left: 21 },
    plainInset: { top: 2, right: 4, bottom: 0, left: 4 },
    body,
    headings: [
      style(20, 27),
      style(17, 24),
      style(15, 22),
      style(15, 22),
      style(14, 21),
      style(13, 20),
    ],
    boldWeight: 650,
    linkColor: 'blue',
    highlight: 'yellow',
    muted: 'grey',
    code: {
      color: 'black',
      background: 'grey',
      scale: 0.86,
      family: 'mono',
      padX: 3,
      radius: 4,
    },
    tag: {
      color: 'blue',
      background: 'lightblue',
      scale: 0.86,
      family: null,
      padX: 6,
      radius: 9,
    },
    list: {
      indent: 24,
      bulletX: -12,
      bulletRadius: 2.5,
      bulletColor: 'grey',
      numberRight: -6,
      numberColor: 'grey',
      padY: 2,
    },
    task: {
      boxX: -20,
      size: 15,
      radius: 4,
      border: 'grey',
      borderWidth: 1,
      checked: 'blue',
      mark: 'white',
      textX: 4,
      doneColor: 'grey',
      doneStrike: true,
    },
    quote: { barWidth: 3, barColor: 'grey', indent: 24, color: 'grey' },
    callout: {
      radius: 8,
      padX: 14,
      padY: 12,
      titleGap: 4,
      padBottom: 36,
      titleWeight: 650,
      types: { note: { color: 'blue', background: 'lightblue' } },
    },
    codeBlock: {
      family: 'mono',
      size: 13,
      lineHeight: 20,
      color: 'black',
      background: 'grey',
      radius: 6,
      padX: 16,
      padY: 24,
      wrap: true,
    },
    table: {
      border: 'grey',
      borderWidth: 1,
      padX: 8,
      padY: 4,
      headerWeight: 650,
      marginY: 16,
    },
    rule: { color: 'grey', thickness: 1 },
    embed: 'grey',
  }
  const metrics = (font: string) => {
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 15)
    return { ascent: size * 0.8, descent: size * 0.2 }
  }
  const run = (markdown: string, height = 1000) =>
    layoutCard({
      sections: parseCard(markdown),
      width: 300,
      height,
      tokens,
      plain: false,
      color: null,
      measure,
      metrics,
    })
  const textOps = (ops: ReturnType<typeof run>) =>
    ops.filter((op) => op.op === 'text')

  test('starts at the inset and spaces blocks by their blank lines', () => {
    const ops = textOps(run('# Title\none\n\ntwo'))
    expect(ops.map((op) => op.op === 'text' && op.text)).toEqual([
      'Title',
      'one',
      'two',
    ])
    const [title, one, two] = ops
    if (title.op !== 'text' || one.op !== 'text' || two.op !== 'text') return
    expect(title.x).toBe(21)
    expect(title.font).toContain('20px')
    // The heading's line, then the paragraph's, then one blank line.
    expect(one.y - title.y).toBeCloseTo(27 / 2 + 24 / 2 + (15 - 20) * 0.3, 0)
    expect(two.y - one.y).toBe(24 * 2)
  })

  test('stops at the bottom edge', () => {
    const many = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n\n')
    expect(textOps(run(many, 200)).length).toBeLessThan(6)
  })

  test('draws markers for bullets, numbers and tasks', () => {
    const ops = run('- a\n\n1. b\n\n- [x] c')
    expect(ops.some((op) => op.op === 'dot')).toBe(true)
    expect(ops.some((op) => op.op === 'text' && op.text === '1.')).toBe(true)
    expect(ops.some((op) => op.op === 'check')).toBe(true)
    // A done task is struck through.
    expect(ops.some((op) => op.op === 'line')).toBe(true)
  })
})
