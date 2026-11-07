import { formulasIn, mathKey, mathOut } from './math'
import { parseCard } from './parse'

/** What `mathOut` takes as formulas, as `I:` and `D:` with their TeX. */
const found = (markdown: string): string[] =>
  [...mathOut(markdown).formulas.values()].map(
    (f) => `${f.display ? 'D' : 'I'}:${f.tex}`,
  )

describe('mathOut', () => {
  // Each as Obsidian 1.15's reading view showed it (2026-11-08).
  test.each([
    ['a$x$b', ['I:x']],
    ['中$x$文', ['I:x']],
    ['$ x$', []],
    ['$x $', []],
    ['$x$5', []],
    ['$x$a', ['I:x']],
    ['$5 and $10', []],
    ['price $5, cost $6', []],
    ['$a*b*c$', ['I:a*b*c']],
    ['`$x$`', []],
    ['$x`y`$', ['I:x`y`']],
    ['BSLASH$x$', []],
    ['$xBSLASH$y$', ['I:xBSLASH$y']],
    ['$$x$$', ['D:x']],
    ['a $$x$$ b', ['D:x']],
    ['$$\nx\n\ny\n$$', ['D:\nx\n\ny\n']],
    ['$x\ny$', ['I:x\ny']],
    ['$x\n\ny$', []],
    ['$a$$b$', ['I:a', 'I:b']],
    ['x$$$y', []],
    ['```\n$x$\n```\n$y$', ['I:y']],
  ])('%j', (markdown, formulas) => {
    const BS = String.fromCharCode(92)
    expect(found(markdown.split('BSLASH').join(BS))).toEqual(
      formulas.map((f) => f.split('BSLASH').join(BS)),
    )
  })

  test('leaves alone the characters an icon font put in the card', () => {
    const icon = String.fromCharCode(0xe000)
    const { text, formulas } = mathOut(`${icon} $x$`)
    expect([...formulas.values()]).toEqual([{ tex: 'x', display: false }])
    expect(text.startsWith(`${icon} `)).toBe(true)
    expect(text).not.toContain('$')
    expect(text.slice(2)).not.toBe(icon)
  })
})

describe('formulas in a parsed card', () => {
  test('inline formulas take the text around them, emphasis and all', () => {
    const [section] = parseCard('energy **$E = mc^2$** here')
    if (section.block.kind !== 'paragraph') throw new Error('a paragraph')
    const math = section.block.inlines.filter((i) => i.math)
    expect(math).toHaveLength(1)
    expect(math[0].math).toEqual({ tex: 'E = mc^2', display: false })
    // Bold, as the run around it is.
    expect(math[0].flags).not.toBe(0)
  })

  test('a display formula alone is a block; one in a line of text is not laid out', () => {
    const alone = parseCard('one\n\n$$\nE = mc^2\n$$\n\ntwo')
    expect(alone.map((s) => s.block.kind)).toEqual([
      'paragraph',
      'math',
      'paragraph',
    ])
    expect(formulasIn(alone)).toEqual({
      formulas: [{ tex: '\nE = mc^2\n', display: true }],
      looseDisplay: false,
    })
    expect(formulasIn(parseCard('a $$x$$ b')).looseDisplay).toBe(true)
  })

  test('formulas are found in lists, quotes and tables, each once', () => {
    const { formulas } = formulasIn(
      parseCard('- $a$ and $a$\n\n> $b$\n\n| $c$ | d |\n| - | - |\n| 1 | 2 |'),
    )
    expect(formulas.map(mathKey)).toEqual(['Ia', 'Ib', 'Ic'])
  })
})
