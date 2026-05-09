// src/core/claude-md/__tests__/claudeMdParser.test.ts

// Mock marked module
jest.mock('marked', () => ({
  marked: {
    lexer: jest.fn(),
  },
}))

// Import the mocked function
import { marked } from 'marked'

import {
  extractIncludePaths,
  parseFrontmatterPaths,
  processIncludes,
  resolveIncludePath,
  stripHtmlComments,
} from '../claudeMdParser'
import { MAX_INCLUDE_DEPTH } from '../claudeMdTypes'

const mockLexer = marked.lexer as jest.Mock

describe('stripHtmlComments', () => {
  beforeEach(() => {
    mockLexer.mockClear()
  })

  it('should strip a block-level HTML comment', () => {
    mockLexer.mockReturnValue([
      {
        type: 'html',
        text: '<!-- hidden -->',
        raw: '<!-- hidden -->',
      },
      {
        type: 'paragraph',
        raw: 'visible content',
        tokens: [],
      },
    ])

    const result = stripHtmlComments('<!-- hidden -->\nvisible content')
    expect(result.content).toBe('visible content')
    expect(result.stripped).toBe(true)
  })

  it('should return unchanged content when no comments exist', () => {
    mockLexer.mockReturnValue([
      {
        type: 'paragraph',
        raw: 'just content',
        tokens: [],
      },
    ])

    const result = stripHtmlComments('just content')
    expect(result.content).toBe('just content')
    expect(result.stripped).toBe(false)
  })

  it('should preserve content inside code blocks', () => {
    const input = '```\n<!-- this is not a comment -->\n```'
    mockLexer.mockReturnValue([
      {
        type: 'code',
        text: '<!-- this is not a comment -->',
        raw: input,
      },
    ])

    const result = stripHtmlComments(input)
    expect(result.content).toBe(input)
  })

  it('should preserve content inside inline code', () => {
    const input = '`<!-- not a comment -->`'
    mockLexer.mockReturnValue([
      {
        type: 'paragraph',
        raw: input,
        tokens: [
          {
            type: 'codespan',
            text: '<!-- not a comment -->',
            raw: '`<!-- not a comment -->`',
          },
        ],
      },
    ])

    const result = stripHtmlComments(input)
    expect(result.content).toBe(input)
  })

  it('should preserve unclosed comments', () => {
    const input = '<!-- unclosed'
    mockLexer.mockReturnValue([
      {
        type: 'html',
        text: '<!-- unclosed',
        raw: '<!-- unclosed',
      },
    ])

    const result = stripHtmlComments(input)
    expect(result.content).toBe(input)
  })

  it('should strip multi-line comments', () => {
    mockLexer.mockReturnValue([
      {
        type: 'html',
        text: '<!-- line1\nline2 -->',
        raw: '<!-- line1\nline2 -->',
      },
      {
        type: 'paragraph',
        raw: 'visible',
        tokens: [],
      },
    ])

    const input = '<!-- line1\nline2 -->\nvisible'
    const result = stripHtmlComments(input)
    expect(result.content).toBe('visible')
    expect(result.stripped).toBe(true)
  })

  it('should preserve residual text after comment', () => {
    mockLexer.mockReturnValue([
      {
        type: 'html',
        text: '<!-- comment --> residual',
        raw: '<!-- comment --> residual',
      },
    ])

    const input = '<!-- comment --> residual'
    const result = stripHtmlComments(input)
    expect(result.content).toBe(' residual')
  })
})

describe('parseFrontmatterPaths', () => {
  it('should return content without paths when no frontmatter', () => {
    const result = parseFrontmatterPaths('just content')
    expect(result.content).toBe('just content')
    expect(result.paths).toBeUndefined()
  })

  it('should parse comma-separated paths', () => {
    const input =
      '---\npaths: src/**/*.ts, tests/**/*.test.ts\n---\nrule content'
    const result = parseFrontmatterPaths(input)
    expect(result.content).toBe('rule content')
    expect(result.paths).toEqual(['src/**/*.ts', 'tests/**/*.test.ts'])
  })

  it('should parse YAML list paths', () => {
    const input = '---\npaths:\n  - a/**\n  - b/**\n---\nrule content'
    const result = parseFrontmatterPaths(input)
    expect(result.paths).toEqual(['a/**', 'b/**'])
  })

  it('should expand braces', () => {
    const input = '---\npaths: src/*.{ts,tsx}\n---\nrule'
    const result = parseFrontmatterPaths(input)
    expect(result.paths).toEqual(['src/*.ts', 'src/*.tsx'])
  })

  it('should treat all-wildcard as no restriction', () => {
    const input = '---\npaths: "**"\n---\nrule'
    const result = parseFrontmatterPaths(input)
    expect(result.paths).toBeUndefined()
  })

  it('should strip /** suffix', () => {
    const input = '---\npaths: src/core/**\n---\nrule'
    const result = parseFrontmatterPaths(input)
    expect(result.paths).toEqual(['src/core'])
  })

  it('should handle YAML parse failure with auto-quote retry', () => {
    const input = '---\npaths: **/*.{ts,tsx}\n---\nrule'
    const result = parseFrontmatterPaths(input)
    expect(result.paths).toEqual(['**/*.ts', '**/*.tsx'])
  })

  it('should return content without paths when frontmatter has no paths', () => {
    const input = '---\nname: my-rule\n---\nrule content'
    const result = parseFrontmatterPaths(input)
    expect(result.content).toBe('rule content')
    expect(result.paths).toBeUndefined()
  })
})

describe('extractIncludePaths', () => {
  beforeEach(() => {
    mockLexer.mockClear()
  })

  it('should extract a relative path', () => {
    mockLexer.mockReturnValue([
      {
        type: 'paragraph',
        raw: 'some text @./shared.md more text',
        tokens: [
          {
            type: 'text',
            text: 'some text @./shared.md more text',
            raw: 'some text @./shared.md more text',
          },
        ],
      },
    ])

    const result = extractIncludePaths('some text @./shared.md more text')
    expect(result).toEqual(['./shared.md'])
  })

  it('should extract vault-root path with ~/', () => {
    mockLexer.mockReturnValue([
      {
        type: 'paragraph',
        raw: '@~/path/to/file.md',
        tokens: [
          {
            type: 'text',
            text: '@~/path/to/file.md',
            raw: '@~/path/to/file.md',
          },
        ],
      },
    ])

    const result = extractIncludePaths('@~/path/to/file.md')
    expect(result).toEqual(['~/path/to/file.md'])
  })

  it('should skip @mentions inside code blocks', () => {
    const input = '```\n@./not-an-include.md\n```'
    mockLexer.mockReturnValue([
      {
        type: 'code',
        text: '@./not-an-include.md',
        raw: input,
      },
    ])

    const result = extractIncludePaths(input)
    expect(result).toEqual([])
  })

  it('should skip @mentions inside inline code', () => {
    const input = '`@./not-include.md`'
    mockLexer.mockReturnValue([
      {
        type: 'paragraph',
        raw: input,
        tokens: [
          {
            type: 'codespan',
            text: '@./not-include.md',
            raw: '`@./not-include.md`',
          },
        ],
      },
    ])

    const result = extractIncludePaths(input)
    expect(result).toEqual([])
  })

  it('should extract multiple paths', () => {
    mockLexer.mockReturnValue([
      {
        type: 'paragraph',
        raw: '@./a.md and @./b.md',
        tokens: [
          {
            type: 'text',
            text: '@./a.md and @./b.md',
            raw: '@./a.md and @./b.md',
          },
        ],
      },
    ])

    const result = extractIncludePaths('@./a.md and @./b.md')
    expect(result).toEqual(['./a.md', './b.md'])
  })

  it('should handle backslash-escaped spaces', () => {
    mockLexer.mockReturnValue([
      {
        type: 'paragraph',
        raw: '@./path\\ with\\ spaces.md',
        tokens: [
          {
            type: 'text',
            text: '@./path\\ with\\ spaces.md',
            raw: '@./path\\ with\\ spaces.md',
          },
        ],
      },
    ])

    const result = extractIncludePaths('@./path\\ with\\ spaces.md')
    expect(result).toEqual(['./path\\ with\\ spaces.md'])
  })

  it('should strip fragment identifiers', () => {
    mockLexer.mockReturnValue([
      {
        type: 'paragraph',
        raw: '@./file.md#section',
        tokens: [
          {
            type: 'text',
            text: '@./file.md#section',
            raw: '@./file.md#section',
          },
        ],
      },
    ])

    const result = extractIncludePaths('@./file.md#section')
    expect(result).toEqual(['./file.md'])
  })
})

describe('resolveIncludePath', () => {
  it('should resolve relative path against current file dir', () => {
    const result = resolveIncludePath({
      includePath: './shared.md',
      currentFilePath: '.claude/rules/agent.md',
      vaultRoot: '',
    })
    expect(result).toBe('.claude/rules/shared.md')
  })

  it('should resolve bare relative path', () => {
    const result = resolveIncludePath({
      includePath: 'shared.md',
      currentFilePath: '.claude/rules/agent.md',
      vaultRoot: '',
    })
    expect(result).toBe('.claude/rules/shared.md')
  })

  it('should resolve ~/ to vault root', () => {
    const result = resolveIncludePath({
      includePath: '~/other/file.md',
      currentFilePath: '.claude/rules/agent.md',
      vaultRoot: '',
    })
    expect(result).toBe('other/file.md')
  })

  it('should reject paths outside vault', () => {
    const result = resolveIncludePath({
      includePath: '/etc/passwd',
      currentFilePath: '.claude/rules/agent.md',
      vaultRoot: '',
    })
    expect(result).toBeNull()
  })
})

describe('processIncludes', () => {
  beforeEach(() => {
    mockLexer.mockClear()
  })

  it('should inline included file content', async () => {
    mockLexer.mockImplementation((content: string) => {
      if (content.includes('@./shared.md')) {
        return [
          {
            type: 'paragraph',
            raw: 'before',
            tokens: [{ type: 'text', text: 'before', raw: 'before' }],
          },
          {
            type: 'paragraph',
            raw: '@./shared.md',
            tokens: [
              { type: 'text', text: '@./shared.md', raw: '@./shared.md' },
            ],
          },
          {
            type: 'paragraph',
            raw: 'after',
            tokens: [{ type: 'text', text: 'after', raw: 'after' }],
          },
        ]
      }
      return [
        {
          type: 'paragraph',
          raw: content,
          tokens: [{ type: 'text', text: content, raw: content }],
        },
      ]
    })

    const fileReader = async (path: string) => {
      const files: Record<string, string> = {
        '.claude/rules/shared.md': 'shared content',
      }
      return files[path] ?? null
    }

    const result = await processIncludes({
      content: 'before\n@./shared.md\nafter',
      currentFilePath: '.claude/rules/agent.md',
      fileReader,
      processedPaths: new Set(),
      depth: 0,
      vaultRoot: '',
    })

    expect(result).toBe('before\nshared content\nafter')
  })

  it('should prevent circular references', async () => {
    mockLexer.mockImplementation((content: string) => {
      return [
        {
          type: 'paragraph',
          raw: content,
          tokens: [{ type: 'text', text: content, raw: content }],
        },
      ]
    })

    const fileReader = async (path: string) => {
      const files: Record<string, string> = {
        'a.md': '@./b.md',
        'b.md': '@./a.md',
      }
      return files[path] ?? null
    }

    const result = await processIncludes({
      content: '@./b.md',
      currentFilePath: 'a.md',
      fileReader,
      processedPaths: new Set(['a.md']),
      depth: 0,
      vaultRoot: '',
    })

    expect(result).toBeDefined()
  })

  it('should stop at max depth', async () => {
    mockLexer.mockImplementation((content: string) => {
      return [
        {
          type: 'paragraph',
          raw: content,
          tokens: [{ type: 'text', text: content, raw: content }],
        },
      ]
    })

    const fileReader = async (_path: string) => 'deep @./deep.md'

    const result = await processIncludes({
      content: '@./deep.md',
      currentFilePath: 'root.md',
      fileReader,
      processedPaths: new Set(),
      depth: MAX_INCLUDE_DEPTH,
      vaultRoot: '',
    })

    expect(result).toContain('@./deep.md')
  })

  it('should skip non-existent includes gracefully', async () => {
    mockLexer.mockImplementation((content: string) => {
      return [
        {
          type: 'paragraph',
          raw: content,
          tokens: [{ type: 'text', text: content, raw: content }],
        },
      ]
    })

    const fileReader = async (_path: string) => null

    const result = await processIncludes({
      content: 'before\n@./missing.md\nafter',
      currentFilePath: 'root.md',
      fileReader,
      processedPaths: new Set(),
      depth: 0,
      vaultRoot: '',
    })

    expect(result).toBe('before\nafter')
  })
})
