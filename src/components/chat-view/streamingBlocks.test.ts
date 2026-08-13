import { splitMarkdownBlocks } from './streamingBlocks'

function split(markdown: string): string[] {
  return splitMarkdownBlocks(markdown).blocks
}

describe('splitMarkdownBlocks', () => {
  it('returns no blocks for empty input', () => {
    expect(split('')).toEqual([])
  })

  it('returns a single block for plain text without newlines', () => {
    expect(split('hello world')).toEqual(['hello world'])
  })

  it('splits paragraphs, headings and lists into top-level blocks', () => {
    const markdown = ['# Title', '', 'First paragraph.', '', '- a', '- b'].join(
      '\n',
    )

    expect(split(markdown)).toEqual([
      '# Title',
      '\n\nFirst paragraph.',
      '\n\n- a\n- b',
    ])
  })

  it('keeps a fenced code block in one piece even with blank lines inside', () => {
    const markdown = ['intro', '', '```ts', 'const a = 1', '', 'a', '```', '']
      .join('\n')
      .concat('done')

    const blocks = split(markdown)

    expect(blocks).toEqual([
      'intro',
      '\n\n```ts\nconst a = 1\n\na\n```',
      '\ndone',
    ])
  })

  it('keeps an unterminated code fence as a single trailing block', () => {
    const markdown = ['intro', '', '```ts', 'const a = 1', ''].join('\n')

    const blocks = split(markdown)

    expect(blocks).toHaveLength(2)
    expect(blocks[1]).toContain('```ts')
  })

  it('keeps a GFM table in one block', () => {
    const markdown = [
      'intro',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n')

    expect(split(markdown)).toEqual([
      'intro',
      '\n\n| a | b |\n| --- | --- |\n| 1 | 2 |',
    ])
  })

  it('merges a display math block that contains a blank line', () => {
    const markdown = ['before', '', '$$', 'a = 1', '', 'b = 2', '$$', ''].join(
      '\n',
    )

    const blocks = split(markdown)

    expect(blocks).toHaveLength(2)
    expect(blocks[1]).toBe('\n\n$$\na = 1\n\nb = 2\n$$\n')
  })

  it('keeps an unclosed display math block attached to the trailing block', () => {
    const markdown = ['before', '', '$$', 'a = 1', '', 'b ='].join('\n')

    const blocks = split(markdown)

    expect(blocks).toHaveLength(2)
    expect(blocks[1]).toBe('\n\n$$\na = 1\n\nb =')
  })

  it('does not split documents containing footnotes', () => {
    const markdown = [
      'Some claim.[^1]',
      '',
      'Another paragraph.',
      '',
      '[^1]: The footnote body.',
    ].join('\n')

    expect(split(markdown)).toEqual([markdown])
  })

  it('still splits answers whose code contains regex character classes', () => {
    // `[^\s]` and friends look like footnote references to a loose pattern.
    // Answers from a coding assistant are full of them, so treating them as
    // footnotes would disable splitting for a large share of real replies.
    const markdown = [
      'Use a negated class:',
      '',
      '```js',
      'const token = /[^\\s]+/g',
      'const quoted = str.match(/"[^"]*"/)',
      '```',
      '',
      'That trims the whitespace.',
    ].join('\n')

    expect(split(markdown).length).toBeGreaterThan(1)
  })

  it('does not split documents containing link reference definitions', () => {
    const markdown = [
      'See the [docs][ref].',
      '',
      'Another paragraph.',
      '',
      '[ref]: https://example.com',
    ].join('\n')

    expect(split(markdown)).toEqual([markdown])
  })

  it('splits CJK content', () => {
    const markdown = ['## 标题', '', '第一段内容。', '', '第二段内容。'].join(
      '\n',
    )

    expect(split(markdown)).toEqual([
      '## 标题',
      '\n\n第一段内容。',
      '\n\n第二段内容。',
    ])
  })

  it('always reproduces the source when joined', () => {
    const documents = [
      '# Title\n\nBody text.\n\n- a\n- b\n\n```js\ncode()\n```\n\n> quote\n\n---\n\nend\n',
      '段落一。\n\n> 引用\n\n1. 第一项\n2. 第二项\n\n$$\nx = 1\n$$\n\n结尾。',
      '\n\n\nleading blank lines\n\n\ntrailing blank lines\n\n\n',
      'no trailing newline',
    ]

    for (const markdown of documents) {
      expect(split(markdown).join('')).toBe(markdown)
    }
  })

  describe('incremental splitting', () => {
    it('reuses every block but the last while the source grows', () => {
      const first = splitMarkdownBlocks('# Title\n\nFirst paragraph.')
      const second = splitMarkdownBlocks(
        '# Title\n\nFirst paragraph.\n\nSecond paragraph.',
        first,
      )

      expect(second.blocks[0]).toBe(first.blocks[0])
      expect(second.blocks).toEqual([
        '# Title',
        '\n\nFirst paragraph.',
        '\n\nSecond paragraph.',
      ])
    })

    it('re-parses the trailing block when appended text changes its type', () => {
      const first = splitMarkdownBlocks('intro\n\n| a | b |')
      const second = splitMarkdownBlocks(
        'intro\n\n| a | b |\n| --- | --- |\n| 1 | 2 |',
        first,
      )

      expect(second.blocks).toEqual([
        'intro',
        '\n\n| a | b |\n| --- | --- |\n| 1 | 2 |',
      ])
    })

    it('re-parses the trailing block when a list turns loose', () => {
      const first = splitMarkdownBlocks('intro\n\n- a\n')
      const second = splitMarkdownBlocks('intro\n\n- a\n\n- b\n', first)

      expect(second.blocks).toEqual(['intro', '\n\n- a\n\n- b\n'])
    })

    it('matches a full split at every prefix of a streamed document', () => {
      const markdown = [
        '# 报告',
        '',
        '第一段内容，包含 `inline code`。',
        '',
        '- 列表项一',
        '- 列表项二',
        '',
        '```ts',
        'const answer = 42',
        '',
        'export default answer',
        '```',
        '',
        '$$',
        'E = mc^2',
        '',
        'F = ma',
        '$$',
        '',
        '| a | b |',
        '| --- | --- |',
        '| 1 | 2 |',
        '',
        '结尾段落。',
      ].join('\n')

      let incremental = splitMarkdownBlocks('')
      for (let length = 1; length <= markdown.length; length++) {
        const prefix = markdown.slice(0, length)
        incremental = splitMarkdownBlocks(prefix, incremental)
        expect(incremental.blocks.join('')).toBe(prefix)
        expect(incremental.blocks).toEqual(splitMarkdownBlocks(prefix).blocks)
      }
    })

    it('falls back to a full split when the source is rewritten', () => {
      const first = splitMarkdownBlocks('# Title\n\nFirst paragraph.')
      const rewritten = splitMarkdownBlocks('Totally different answer.', first)

      expect(rewritten.blocks).toEqual(['Totally different answer.'])
    })

    it('recovers from a cached split once a footnote appears', () => {
      const first = splitMarkdownBlocks('Some claim.\n\nAnother paragraph.')
      const withFootnote = splitMarkdownBlocks(
        'Some claim.\n\nAnother paragraph.[^1]\n\n[^1]: body',
        first,
      )

      expect(withFootnote.blocks).toEqual([
        'Some claim.\n\nAnother paragraph.[^1]\n\n[^1]: body',
      ])
    })
  })
})
