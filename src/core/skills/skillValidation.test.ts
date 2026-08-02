import {
  parseFrontmatter,
  validateCompatibility,
  validateDescription,
  validateDirectoryPackage,
  validateSingleFileSkill,
  validateSkillName,
  wrapMarkdownAsSkillPackage,
} from './skillValidation'

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------

describe('parseFrontmatter', () => {
  it('parses valid frontmatter with simple key-value pairs', () => {
    const content = `---\nname: my-skill\ndescription: A test skill\n---\n\n# Body`
    const result = parseFrontmatter(content)
    expect(result).toEqual({
      name: 'my-skill',
      description: 'A test skill',
    })
  })

  it('handles quoted values', () => {
    const content = `---\nname: "my-skill"\ndescription: 'A test skill'\n---\n`
    const result = parseFrontmatter(content)
    expect(result).toEqual({
      name: 'my-skill',
      description: 'A test skill',
    })
  })

  it('parses nested map (metadata field)', () => {
    const content = `---\nname: my-skill\nmetadata:\n  author: example-org\n  version: "1.0"\n---\n`
    const result = parseFrontmatter(content)
    expect(result).toEqual({
      name: 'my-skill',
      metadata: { author: 'example-org', version: '1.0' },
    })
  })

  it('returns null when no frontmatter delimiter', () => {
    const content = `# Just a markdown file\n\nNo frontmatter here.`
    expect(parseFrontmatter(content)).toBeNull()
  })

  it('returns null when closing delimiter is missing', () => {
    const content = `---\nname: my-skill\ndescription: broken\n`
    expect(parseFrontmatter(content)).toBeNull()
  })

  it('handles Windows line endings (CRLF)', () => {
    const content = '---\r\nname: my-skill\r\ndescription: test\r\n---\r\n'
    const result = parseFrontmatter(content)
    expect(result).toEqual({
      name: 'my-skill',
      description: 'test',
    })
  })

  it('parses multiline folded scalar (>-)', () => {
    const content = [
      '---',
      'name: my-skill',
      'description: >-',
      '  This is a long description',
      '  that spans multiple lines.',
      '---',
    ].join('\n')
    const result = parseFrontmatter(content)
    expect(result).toEqual({
      name: 'my-skill',
      description: 'This is a long description that spans multiple lines.',
    })
  })

  it('parses multiline literal scalar (|)', () => {
    const content = [
      '---',
      'name: my-skill',
      'description: |',
      '  Line one',
      '  Line two',
      '---',
    ].join('\n')
    const result = parseFrontmatter(content)
    // js-yaml '|' 保留换行,末尾默认带一个 newline
    expect(result).toEqual({
      name: 'my-skill',
      description: 'Line one\nLine two\n',
    })
  })

  it('does not treat --- in YAML value as closing delimiter', () => {
    // 中间的 `bar---` 不应被视为 closing delimiter,因为它不独占一行
    const content = [
      '---',
      'name: my-skill',
      'description: "foo bar---baz"',
      '---',
      '',
      '# Body',
    ].join('\n')
    const result = parseFrontmatter(content)
    expect(result).toEqual({
      name: 'my-skill',
      description: 'foo bar---baz',
    })
  })

  it('handles empty frontmatter', () => {
    const content = `---\n---\n\n# Body`
    const result = parseFrontmatter(content)
    expect(result).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// validateSkillName
// ---------------------------------------------------------------------------

describe('validateSkillName', () => {
  it('passes for valid names', () => {
    expect(validateSkillName('pdf-processing')).toEqual([])
    expect(validateSkillName('data-analysis')).toEqual([])
    expect(validateSkillName('code-review')).toEqual([])
    expect(validateSkillName('a')).toEqual([])
    expect(validateSkillName('skill123')).toEqual([])
    expect(validateSkillName('my-skill-v2')).toEqual([])
  })

  it('fails when name is missing', () => {
    expect(validateSkillName(undefined)).toEqual([
      { field: 'name', message: 'missing' },
    ])
    expect(validateSkillName(null)).toEqual([
      { field: 'name', message: 'missing' },
    ])
    expect(validateSkillName('')).toEqual([
      { field: 'name', message: 'missing' },
    ])
    expect(validateSkillName('   ')).toEqual([
      { field: 'name', message: 'missing' },
    ])
  })

  it('fails when name exceeds 64 characters', () => {
    const longName = 'a'.repeat(65)
    const errors = validateSkillName(longName)
    expect(errors).toContainEqual({
      field: 'name',
      message: 'exceeds 64 characters',
    })
  })

  it('fails when name contains uppercase', () => {
    expect(validateSkillName('PDF-Processing')).toContainEqual({
      field: 'name',
      message: 'uppercase not allowed',
    })
  })

  it('fails when name starts with hyphen', () => {
    expect(validateSkillName('-pdf')).toContainEqual({
      field: 'name',
      message: 'cannot start or end with hyphen',
    })
  })

  it('fails when name ends with hyphen', () => {
    expect(validateSkillName('pdf-')).toContainEqual({
      field: 'name',
      message: 'cannot start or end with hyphen',
    })
  })

  it('fails when name contains consecutive hyphens', () => {
    expect(validateSkillName('pdf--processing')).toContainEqual({
      field: 'name',
      message: 'consecutive hyphens not allowed',
    })
  })

  it('fails when name contains invalid characters', () => {
    expect(validateSkillName('my_skill')).toContainEqual({
      field: 'name',
      message: 'only lowercase letters, numbers, and hyphens allowed',
    })
    expect(validateSkillName('my skill')).toContainEqual({
      field: 'name',
      message: 'only lowercase letters, numbers, and hyphens allowed',
    })
    expect(validateSkillName('技能')).toContainEqual({
      field: 'name',
      message: 'only lowercase letters, numbers, and hyphens allowed',
    })
  })

  it('passes for single character name', () => {
    expect(validateSkillName('a')).toEqual([])
    expect(validateSkillName('1')).toEqual([])
  })

  it('passes for exactly 64 characters', () => {
    const name = 'a'.repeat(64)
    expect(validateSkillName(name)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// validateDescription
// ---------------------------------------------------------------------------

describe('validateDescription', () => {
  it('passes for valid description', () => {
    expect(validateDescription('Extracts text from PDF files.')).toEqual([])
  })

  it('fails when description is missing', () => {
    expect(validateDescription(undefined)).toEqual([
      { field: 'description', message: 'missing' },
    ])
    expect(validateDescription(null)).toEqual([
      { field: 'description', message: 'missing' },
    ])
    expect(validateDescription('')).toEqual([
      { field: 'description', message: 'missing' },
    ])
    expect(validateDescription('   ')).toEqual([
      { field: 'description', message: 'missing' },
    ])
  })

  it('fails when description exceeds 1024 characters', () => {
    const longDesc = 'a'.repeat(1025)
    expect(validateDescription(longDesc)).toContainEqual({
      field: 'description',
      message: 'exceeds 1024 characters',
    })
  })

  it('passes for exactly 1024 characters', () => {
    const desc = 'a'.repeat(1024)
    expect(validateDescription(desc)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// validateCompatibility
// ---------------------------------------------------------------------------

describe('validateCompatibility', () => {
  it('passes when not provided', () => {
    expect(validateCompatibility(undefined)).toEqual([])
    expect(validateCompatibility(null)).toEqual([])
  })

  it('passes for valid compatibility string', () => {
    expect(validateCompatibility('Requires Python 3.14+ and uv')).toEqual([])
  })

  it('fails when exceeds 500 characters', () => {
    const longCompat = 'a'.repeat(501)
    expect(validateCompatibility(longCompat)).toContainEqual({
      field: 'compatibility',
      message: 'exceeds 500 characters',
    })
  })

  it('passes for exactly 500 characters', () => {
    const compat = 'a'.repeat(500)
    expect(validateCompatibility(compat)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// validateDirectoryPackage
// ---------------------------------------------------------------------------

describe('validateDirectoryPackage', () => {
  const validSkillMd = [
    '---',
    'name: my-skill',
    'description: A useful skill for testing purposes.',
    '---',
    '',
    '# Instructions',
    '',
    'Do the thing.',
  ].join('\n')

  it('passes for a valid skill package', () => {
    const files = [
      { relativePath: 'SKILL.md', content: validSkillMd },
      { relativePath: 'scripts/run.py', content: '# script' },
    ]
    expect(validateDirectoryPackage('my-skill', files)).toEqual([])
  })

  it('fails when SKILL.md is missing', () => {
    const files = [{ relativePath: 'README.md', content: '# readme' }]
    const errors = validateDirectoryPackage('my-skill', files)
    expect(errors).toContainEqual({
      field: 'SKILL.md',
      message: 'missing',
    })
  })

  it('fails when SKILL.md has no frontmatter', () => {
    const files = [
      { relativePath: 'SKILL.md', content: '# No frontmatter here' },
    ]
    const errors = validateDirectoryPackage('my-skill', files)
    expect(errors).toContainEqual({
      field: 'frontmatter',
      message: 'missing or invalid',
    })
  })

  it('fails when name is invalid and description is missing', () => {
    const content = ['---', 'name: My-Skill', '---'].join('\n')
    const files = [{ relativePath: 'SKILL.md', content }]
    const errors = validateDirectoryPackage('My-Skill', files)
    expect(errors).toContainEqual({
      field: 'name',
      message: 'uppercase not allowed',
    })
    expect(errors).toContainEqual({
      field: 'description',
      message: 'missing',
    })
  })

  it('fails when description is missing', () => {
    const content = ['---', 'name: my-skill', '---'].join('\n')
    const files = [{ relativePath: 'SKILL.md', content }]
    const errors = validateDirectoryPackage('my-skill', files)
    expect(errors).toContainEqual({
      field: 'description',
      message: 'missing',
    })
  })

  it('validates optional compatibility field', () => {
    const content = [
      '---',
      'name: my-skill',
      'description: A skill.',
      `compatibility: ${'x'.repeat(501)}`,
      '---',
    ].join('\n')
    const files = [{ relativePath: 'SKILL.md', content }]
    const errors = validateDirectoryPackage('my-skill', files)
    expect(errors).toContainEqual({
      field: 'compatibility',
      message: 'exceeds 500 characters',
    })
  })

  it('fails when frontmatter.name does not match folder name', () => {
    const content = [
      '---',
      'name: pdf-processing',
      'description: A useful skill.',
      '---',
    ].join('\n')
    const files = [{ relativePath: 'SKILL.md', content }]
    const errors = validateDirectoryPackage('different-folder', files)
    expect(errors).toContainEqual({
      field: 'name',
      message: 'must match folder name',
    })
  })

  it('does not report mismatch when name is already invalid', () => {
    const content = [
      '---',
      'name: PDF-Processing',
      'description: A useful skill.',
      '---',
    ].join('\n')
    const files = [{ relativePath: 'SKILL.md', content }]
    const errors = validateDirectoryPackage('pdf-processing', files)
    expect(errors).toContainEqual({
      field: 'name',
      message: 'uppercase not allowed',
    })
    expect(errors).not.toContainEqual({
      field: 'name',
      message: 'must match folder name',
    })
  })

  it('passes with all optional fields valid', () => {
    const content = [
      '---',
      'name: pdf-processing',
      'description: Extract PDF text, fill forms, merge files.',
      'license: Apache-2.0',
      'compatibility: Requires Python 3.14+',
      'metadata:',
      '  author: example-org',
      '  version: "1.0"',
      '---',
      '',
      '# Instructions',
    ].join('\n')
    const files = [
      { relativePath: 'SKILL.md', content },
      { relativePath: 'scripts/extract.py', content: '# python' },
      { relativePath: 'references/REFERENCE.md', content: '# ref' },
    ]
    expect(validateDirectoryPackage('pdf-processing', files)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// validateSingleFileSkill
// ---------------------------------------------------------------------------

describe('validateSingleFileSkill', () => {
  it('passes for valid single file skill', () => {
    const content = [
      '---',
      'name: my-custom-skill',
      'description: Does something useful.',
      '---',
      '',
      '# Instructions',
    ].join('\n')
    expect(validateSingleFileSkill(content)).toEqual([])
  })

  it('fails when no frontmatter', () => {
    const content = '# Just markdown\n\nNo frontmatter.'
    expect(validateSingleFileSkill(content)).toContainEqual({
      field: 'frontmatter',
      message: 'missing or invalid',
    })
  })

  it('fails when name is missing from frontmatter', () => {
    const content = ['---', 'description: A skill without a name.', '---'].join(
      '\n',
    )
    expect(validateSingleFileSkill(content)).toContainEqual({
      field: 'name',
      message: 'missing',
    })
  })

  it('requires a standards-valid name and description before wrapping', () => {
    const content = ['---', 'name: Any Name With Spaces', '---'].join('\n')
    expect(validateSingleFileSkill(content)).toEqual(
      expect.arrayContaining([
        { field: 'name', message: 'uppercase not allowed' },
        { field: 'description', message: 'missing' },
      ]),
    )
  })

  it('passes with all frontmatter fields', () => {
    const content = [
      '---',
      'id: custom-id',
      'name: my-skill',
      'description: Detailed description here.',
      'mode: always',
      '---',
      '',
      'Body content.',
    ].join('\n')
    expect(validateSingleFileSkill(content)).toEqual([])
  })

  it('wraps a single Markdown input as <frontmatter.name>/SKILL.md', () => {
    const content = [
      '---',
      'name: imported-skill',
      'description: Imported from one Markdown file.',
      '---',
      '# Instructions',
    ].join('\n')

    expect(wrapMarkdownAsSkillPackage(content)).toEqual({
      package: {
        name: 'imported-skill',
        description: 'Imported from one Markdown file.',
        files: [{ relativePath: 'SKILL.md', content }],
      },
      errors: [],
    })
  })

  it('does not derive package identity from an invalid input filename', () => {
    const content = ['---', 'description: Missing name.', '---'].join('\n')
    const result = wrapMarkdownAsSkillPackage(content)

    expect(result.package).toBeNull()
    expect(result.errors).toContainEqual({ field: 'name', message: 'missing' })
  })
})
