import { extractLatexSources } from './latex-copy'

describe('extractLatexSources', () => {
  it('extracts inline and block latex in document order', () => {
    const markdown = [
      'Inline math $a^2 + b^2 = c^2$ here.',
      '',
      '$$',
      '\\int_0^1 x^2 \\mathrm{d}x',
      '$$',
      '',
      'And \\(x + y\\) at the end.',
    ].join('\n')

    expect(extractLatexSources(markdown)).toEqual([
      '$a^2 + b^2 = c^2$',
      '$$\n\\int_0^1 x^2 \\mathrm{d}x\n$$',
      '\\(x + y\\)',
    ])
  })

  it('ignores latex-looking text inside fenced and inline code', () => {
    const markdown = [
      'Code `$not_math$` should stay ignored.',
      '',
      '```ts',
      'const sample = "$still_not_math$"',
      '```',
      '',
      'Visible math: $real_math$ and \\[x^2\\].',
    ].join('\n')

    expect(extractLatexSources(markdown)).toEqual(['$real_math$', '\\[x^2\\]'])
  })

  it('keeps original delimiters for copy output', () => {
    const markdown = 'Use $$\\frac{1}{2}$$ or $\\alpha$.'

    expect(extractLatexSources(markdown)).toEqual([
      '$$\\frac{1}{2}$$',
      '$\\alpha$',
    ])
  })

  it('preserves list indentation for block latex', () => {
    const markdown = [
      '4. Taylor example',
      '',
      '   $$',
      '   e^x = \\sum_{n=0}^{\\infty} \\frac{x^n}{n!}',
      '   $$',
      '',
      '5. Next item',
    ].join('\n')

    expect(extractLatexSources(markdown)).toEqual([
      ['   $$', '   e^x = \\sum_{n=0}^{\\infty} \\frac{x^n}{n!}', '   $$'].join(
        '\n',
      ),
    ])
  })

  it('does not treat escaped bracket delimiters as latex', () => {
    const markdown = String.raw`Show delimiters: \\(not math\\) and \\\[still not math\\]. Real math: \(x+y\)`

    expect(extractLatexSources(markdown)).toEqual([String.raw`\(x+y\)`])
  })

  it('ignores formulas inside fenced code blocks with up to three leading spaces', () => {
    const markdown = [
      '1. Example',
      '',
      '   ```md',
      '   $fake$',
      '   ```',
      '',
      '   $$',
      '   real',
      '   $$',
    ].join('\n')

    expect(extractLatexSources(markdown)).toEqual([
      ['   $$', '   real', '   $$'].join('\n'),
    ])
  })
})
