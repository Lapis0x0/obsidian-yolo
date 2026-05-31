import {
  buildReadableMarkdownText,
  normalizeReadAloudSelectionText,
  splitReadAloudText,
} from './readAloudText'

describe('read-aloud text preparation', () => {
  it('normalizes selected text whitespace without changing content', () => {
    expect(
      normalizeReadAloudSelectionText('  Alpha  \r\n\r\n\r\nBeta\t \n'),
    ).toBe('Alpha\n\nBeta')
  })

  it('strips markdown structure into readable text', () => {
    const markdown = [
      '---',
      'title: Hidden',
      '---',
      '# Heading',
      '',
      '- [Link text](https://example.com)',
      '- ![[Audio note.md|clip]]',
      '',
      '```ts',
      'const hidden = true',
      '```',
      '',
      '> Quote with ^block-id',
    ].join('\n')

    const text = buildReadableMarkdownText(markdown)

    expect(text).toContain('Heading')
    expect(text).toContain('Link text')
    expect(text).toContain('Audio note')
    expect(text).toContain('Quote with')
    expect(text).not.toContain('title: Hidden')
    expect(text).not.toContain('const hidden')
    expect(text).not.toContain('^block-id')
  })

  it('splits long text by paragraphs before using fixed windows', () => {
    const text = [
      'First paragraph is short.',
      '',
      'Second paragraph is also short.',
      '',
      'A'.repeat(520),
    ].join('\n')

    const chunks = splitReadAloudText(text, 240)

    expect(chunks[0]).toBe(
      'First paragraph is short.\n\nSecond paragraph is also short.',
    )
    expect(chunks.slice(1).every((chunk) => chunk.length <= 240)).toBe(true)
    expect(chunks.join('').replace(/\n/g, '')).toContain('A'.repeat(520))
  })
})
