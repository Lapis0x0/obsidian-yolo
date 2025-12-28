import {
  escapeMarkdownSpecialChars,
  unescapeMarkdownSpecialChars,
} from './markdown-escape'

describe('escapeMarkdownSpecialChars', () => {
  it('should escape angle brackets in simple text', () => {
    const input = 'Use <keyword> to specify a value'
    const result = escapeMarkdownSpecialChars(input)
    expect(result).toBe('Use \\<keyword\\> to specify a value')
  })

  it('should escape angle brackets in command examples', () => {
    const input = 'For example, use winget search <keyword> to find packages.'
    const result = escapeMarkdownSpecialChars(input)
    expect(result).toBe(
      'For example, use winget search \\<keyword\\> to find packages.'
    )
  })

  it('should escape multiple angle bracket pairs', () => {
    const input = 'Copy <source> to <destination>'
    const result = escapeMarkdownSpecialChars(input)
    expect(result).toBe('Copy \\<source\\> to \\<destination\\>')
  })

  it('should preserve code blocks when enabled', () => {
    const input = 'Use `<keyword>` in code or <value> in text'
    const result = escapeMarkdownSpecialChars(input, {
      preserveCodeBlocks: true,
    })
    expect(result).toBe('Use `<keyword>` in code or \\<value\\> in text')
  })

  it('should preserve triple backtick code blocks', () => {
    const input = 'Example:\n```\n<tag>content</tag>\n```\nUse <value> outside'
    const result = escapeMarkdownSpecialChars(input, {
      preserveCodeBlocks: true,
    })
    expect(result).toBe(
      'Example:\n```\n<tag>content</tag>\n```\nUse \\<value\\> outside'
    )
  })

  it('should not escape when disabled', () => {
    const input = 'Use <keyword> here'
    const result = escapeMarkdownSpecialChars(input, {
      escapeAngleBrackets: false,
    })
    expect(result).toBe('Use <keyword> here')
  })

  it('should handle text without special characters', () => {
    const input = 'This is plain text without any special characters'
    const result = escapeMarkdownSpecialChars(input)
    expect(result).toBe('This is plain text without any special characters')
  })

  it('should escape opening angle bracket only', () => {
    const input = 'Start with <incomplete bracket'
    const result = escapeMarkdownSpecialChars(input)
    expect(result).toBe('Start with \\<incomplete bracket')
  })

  it('should escape closing angle bracket only', () => {
    const input = 'Incomplete bracket> at end'
    const result = escapeMarkdownSpecialChars(input)
    expect(result).toBe('Incomplete bracket\\> at end')
  })

  it('should handle empty string', () => {
    const input = ''
    const result = escapeMarkdownSpecialChars(input)
    expect(result).toBe('')
  })

  it('should handle text with mixed inline and block code', () => {
    const input =
      'Use `<inline>` code and:\n```js\nconst x = <T>()\n```\nThen <value>'
    const result = escapeMarkdownSpecialChars(input, {
      preserveCodeBlocks: true,
    })
    expect(result).toBe(
      'Use `<inline>` code and:\n```js\nconst x = <T>()\n```\nThen \\<value\\>'
    )
  })
})

describe('unescapeMarkdownSpecialChars', () => {
  it('should unescape angle brackets', () => {
    const input = 'Use \\<keyword\\> to specify a value'
    const result = unescapeMarkdownSpecialChars(input)
    expect(result).toBe('Use <keyword> to specify a value')
  })

  it('should unescape multiple pairs', () => {
    const input = 'Copy \\<source\\> to \\<destination\\>'
    const result = unescapeMarkdownSpecialChars(input)
    expect(result).toBe('Copy <source> to <destination>')
  })

  it('should handle empty string', () => {
    const input = ''
    const result = unescapeMarkdownSpecialChars(input)
    expect(result).toBe('')
  })

  it('should be inverse of escape function', () => {
    const original = 'Use <keyword> in command <value> here'
    const escaped = escapeMarkdownSpecialChars(original)
    const unescaped = unescapeMarkdownSpecialChars(escaped)
    expect(unescaped).toBe(original)
  })
})
