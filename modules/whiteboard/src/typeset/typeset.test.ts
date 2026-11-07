import { breakLines, breakOpportunities } from './breaking'
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
import { calloutTitlesApart, linkText, parseCard } from './parse'
import type { TextStyle, TypesetTokens } from './tokens'

// Latin 8 units a character, CJK 16: enough to reason about where lines
// break without a font.
const measure = (text: string): number =>
  Array.from(text).reduce(
    (sum, ch) => sum + ((ch.codePointAt(0) ?? 0) > 0x2e80 ? 16 : 8),
    0,
  )
const plain = () => ({ font: 'f', padX: 0, linkIcon: 0 })
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
      '> [!Tip] Title here\n> body\n\n> quoted\n\n- [ ] todo\n- [x] done\n\n3. three\n\n![[note]]',
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
    expect(embed).toEqual({ kind: 'embed', target: 'note' })
  })

  test('a callout body starts under its title, a list included', () => {
    const [section] = parseCard(
      '> [!question] Q\n> 18. eighteen\n> 19. nineteen',
    )
    const callout = section.block
    if (callout.kind !== 'callout') throw new Error(callout.kind)
    expect(callout.title.map((i) => i.text).join('')).toBe('Q')
    expect(callout.children[0].block).toMatchObject({
      kind: 'list',
      ordered: true,
      start: 18,
    })
    // Not inside code.
    expect(calloutTitlesApart('```\n> [!x] t\n> y\n```')).toBe(
      '```\n> [!x] t\n> y\n```',
    )
  })

  test('a folded callout shows only its title', () => {
    const [section] = parseCard('> [!info]- Files\n> - one\n> - two')
    if (section.block.kind !== 'callout') throw new Error(section.block.kind)
    expect(section.block.children).toEqual([])
  })

  test('an empty task is a task', () => {
    const [section] = parseCard('- [ ] \n- [x]\n- [ ] todo')
    if (section.block.kind !== 'list') throw new Error(section.block.kind)
    expect(section.block.items.map((i) => i.checked)).toEqual([
      false,
      true,
      false,
    ])
    expect(section.block.items[0].children).toEqual([])
  })

  test('an external link ends in its icon, a wikilink does not', () => {
    const [section] = parseCard('[a](https://x.y) [[b]] https://z.w')
    if (section.block.kind !== 'paragraph') throw new Error(section.block.kind)
    expect(section.block.inlines.filter((i) => i.linkIcon).length).toBe(2)
  })

  test("a line of text after a quote's empty line is the quote's", () => {
    const kinds = (markdown: string) =>
      parseCard(markdown).map((section) => section.block.kind)
    expect(kinds('> a\n>\nb\n\nafter')).toEqual(['quote', 'paragraph'])
    expect(kinds('> a\n>\n\nb')).toEqual(['quote', 'paragraph'])
    expect(kinds('> a\n>\n# h')).toEqual(['quote', 'heading'])
  })

  test('a line of spaces indented into an item keeps a list tight', () => {
    const spread = (markdown: string) => {
      const [section] = parseCard(markdown)
      if (section.block.kind !== 'list') throw new Error(section.block.kind)
      return section.block.spread
    }
    expect(spread('- a\n    \n- b')).toBe(false)
    expect(spread('- a\n  \n- b')).toBe(false)
    // Indented less than the item's content, or empty: a blank line.
    expect(spread('- a\n \n- b')).toBe(true)
    expect(spread('- a\n\n- b')).toBe(true)
    // Before more of the item's own: blank, and the item loose.
    expect(spread('1. a\n   \n   - b\n2. c')).toBe(true)
  })

  test('an image on the web is an image, though its address names no type', () => {
    const [section] = parseCard('![图片](https://a.b/640?wx_fmt=png#i=0)')
    if (section.block.kind !== 'paragraph') throw new Error(section.block.kind)
    expect(section.block.inlines[0].image?.target).toBe(
      'https://a.b/640?wx_fmt=png',
    )
  })

  test('a link shows its alias, or its heading steps', () => {
    expect(linkText('note|alias')).toBe('alias')
    expect(linkText('note#one#two')).toBe('note > one > two')
    expect(linkText('#one')).toBe('one')
    expect(linkText('note#^block')).toBe('note > ^block')
  })
})

describe('breakOpportunities', () => {
  // Each case measured in Chrome (spike/break-oracle.mjs).
  const breaksIn = (text: string) =>
    [...breakOpportunities(text)]
      .filter((p) => p > 0 && p < text.length)
      .sort((a, b) => a - b)
      .map((p) => `${text.slice(0, p)}|${text.slice(p)}`)
  test('a hyphen before a digit, after a letter or digit only', () => {
    expect(breaksIn('2026-07')).toEqual(['2026-|07'])
    expect(breaksIn('(-1')).toEqual([])
  })
  test('ASCII pairs by Chrome’s table', () => {
    expect(breaksIn('logs/app')).toEqual([])
    expect(breaksIn('a--b')).toEqual(['a-|-b', 'a--|b'])
    expect(breaksIn('x,(y')).toEqual(['x,|(y'])
  })
  test('after spaces, always', () => {
    expect(breaksIn('资源 。')).toContain('资源 |。')
  })
  test('curly double quotes break as brackets, single ones do not', () => {
    expect(breaksIn('的“记”的')).toEqual(['的|“记”的', '的“记”|的'])
    expect(breaksIn('Let’s')).toEqual([])
  })
  test('before a full-width opening bracket after Latin', () => {
    expect(breaksIn('SSRI（选')).toContain('SSRI|（选')
  })
  test('before the prolonged sound mark', () => {
    expect(breaksIn('データ')).toEqual(['デ|ータ', 'デー|タ'])
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

  test('sets adjacent full-width marks in an em and a half', () => {
    // "，「" gives up the comma's blank half, as the browser's
    // text-spacing-trim does, and the opening mark starts a new piece there.
    const [line] = breakLines(
      [{ text: '前，「会', flags: 0 }],
      200,
      plain,
      measure,
    )
    expect(line.width).toBe(16 * 3.5)
    expect(line.pieces.map((p) => [p.text, p.x])).toEqual([
      ['前，', 0],
      ['「会', 24],
    ])
  })

  test('a closing bracket at the end of a line may overhang by half, a stop may not', () => {
    // Four characters are 64 wide, on a line 60 wide.
    const lines = (text: string) =>
      texts(breakLines([{ text, flags: 0 }], 60, plain, measure))
    expect(lines('一二三）')).toEqual(['一二三）'])
    expect(lines('一二三。')).toEqual(['一二', '三。'])
  })

  test('a pair of marks gives up its room once, though the canvas trims it too', () => {
    // A canvas measures "）。" as an em and a half, as the browser sets it.
    const trimming = (text: string) =>
      measure(text) - (text.includes('）。') ? 8 : 0)
    const [line] = breakLines(
      [{ text: '坑）。三', flags: 0 }],
      400,
      plain,
      trimming,
    )
    expect(line.width).toBe(16 * 3.5)
  })

  test('an opening quote before an opening mark gives up room, a closing one does not', () => {
    const width = (text: string) =>
      breakLines([{ text, flags: 0 }], 400, plain, measure)[0].width
    expect(width('“（')).toBeLessThan(width('“') + width('（'))
    expect(width('”（')).toBe(width('”') + width('（'))
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
      (flags) => ({ font: 'f', padX: flags & CODE ? 4 : 0, linkIcon: 0 }),
      measure,
    )
    expect(texts(lines)).toEqual(['a', 'code'])
    expect(lines[1].pieces[0]).toMatchObject({ width: 32 + 8, padLeft: 4 })
  })

  test('a pill broken over two lines is padded at both ends of each', () => {
    const lines = breakLines(
      [{ text: 'aaaa bbbb', flags: CODE }],
      50,
      (flags) => ({ font: 'f', padX: flags & CODE ? 4 : 0, linkIcon: 0 }),
      measure,
    )
    expect(texts(lines)).toEqual(['aaaa', 'bbbb'])
    expect(lines[0].pieces[0]).toMatchObject({ width: 40, padLeft: 4 })
    expect(lines[1].pieces[0]).toMatchObject({ width: 40, padLeft: 4 })
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
    baseline: (lineHeight - size * 1.2) / 2 + size,
  })
  const body = style(15, 24)
  const line = { width: 1, color: 'grey' }
  const GRID = [line, line, line, line] as const
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
    linkIcon: 0,
    highlight: { background: 'yellow', padX: 0, padY: 0, radius: 2 },
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
    quote: {
      left: 0,
      right: 0,
      barWidth: 3,
      barColor: 'grey',
      indent: 24,
      color: 'grey',
    },
    callout: {
      radius: 8,
      padX: 14,
      padY: 12,
      titleGap: 4,
      padBottom: 36,
      title: { ...body, size: 15, lineHeight: 19.5, weight: 650 },
      titleIndent: 20,
      icon: 16,
      types: { note: { color: 'blue', background: 'lightblue' } },
    },
    codeBlock: {
      family: 'mono',
      size: 13,
      lineHeight: 20,
      baseline: 15,
      color: 'black',
      background: 'grey',
      radius: 6,
      padX: 16,
      padY: 24,
      wrap: true,
    },
    table: {
      frame: { width: 0, color: 'grey' },
      collapse: true,
      spacing: 0,
      borders: {
        header: { first: GRID, last: GRID },
        body: { first: GRID, last: GRID },
      },
      padX: 8,
      padY: 4,
      marginY: 16,
      header: { ...body, weight: 650 },
      cell: body,
      headerAlign: 'left',
      align: 'left',
      headerMinWidth: 0,
      minWidth: 0,
      headerBackground: 'transparent',
      rowBackgrounds: ['transparent', 'transparent'],
    },
    rule: { color: 'grey', thickness: 1 },
    embed: 'grey',
    image: { border: { width: 0, color: 'grey' }, radius: 0 },
    emoji: 1,
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
    // Each baseline where its style puts it: a 27-high line, then the
    // paragraph's 24.
    expect(one.y - title.y).toBe(27 + 18 - 21.5)
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

describe('images', () => {
  test('an embed is an image in its line, sized by its own size', () => {
    const [section] = parseCard('a ![[pic.png|200]] b')
    if (section.block.kind !== 'paragraph') throw new Error('paragraph')
    expect(section.block.inlines.find((i) => i.image)?.image).toEqual({
      target: 'pic.png',
      width: 200,
      height: null,
    })
    expect(parseCard('![[note]]')[0].block.kind).toBe('embed')
  })

  test('a line with an image stands on it: the baseline drops by its height', () => {
    const ops = layoutCard({
      sections: parseCard('![[pic.png]]\nafter'),
      width: 300,
      height: 2000,
      tokens: {
        ...({} as TypesetTokens),
        inset: { top: 0, right: 0, bottom: 0, left: 0 },
        plainInset: { top: 0, right: 0, bottom: 0, left: 0 },
        body: {
          family: 'f',
          size: 15,
          weight: 400,
          italic: false,
          color: 'black',
          lineHeight: 24,
          baseline: 18,
        },
        boldWeight: 700,
        embed: 'grey',
        image: { border: { width: 0, color: 'grey' }, radius: 0 },
      } as TypesetTokens,
      plain: true,
      color: null,
      measure,
      metrics: () => ({ ascent: 12, descent: 3 }),
      images: () => ({ w: 600, h: 300 }),
    })
    const image = ops.find((op) => op.op === 'image')
    // Never wider than its line; in proportion.
    expect(image).toMatchObject({ x: 0, y: 0, w: 300, h: 150 })
    const after = ops.find((op) => op.op === 'text' && op.text === 'after')
    // Its line: the image on the baseline, the line's descent below it.
    if (after?.op !== 'text') throw new Error('text')
    expect(after.y).toBeCloseTo(
      150 + (24 - 15) / 2 + 3 + 24 - 3 - (24 - 15) / 2,
      0,
    )
  })
})
