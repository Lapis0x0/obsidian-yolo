import {
  parseFrontmatter,
  validateDirectoryPackage,
  validateSingleFileSkill,
  validateSkillName,
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
  it('accepts any non-empty string without enforcing a naming convention', () => {
    expect(validateSkillName('pdf-processing')).toEqual([])
    expect(validateSkillName('PDF Processing')).toEqual([])
    expect(validateSkillName('技能')).toEqual([])
    expect(validateSkillName('a'.repeat(65))).toEqual([])
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

  it('accepts missing description and a non-standard name', () => {
    const content = ['---', 'name: My Skill', '---'].join('\n')
    const files = [{ relativePath: 'SKILL.md', content }]
    expect(validateDirectoryPackage('different-folder', files)).toEqual([])
  })

  it('fails when name is missing', () => {
    const content = ['---', 'description: No name', '---'].join('\n')
    const files = [{ relativePath: 'SKILL.md', content }]
    const errors = validateDirectoryPackage('my-skill', files)
    expect(errors).toContainEqual({
      field: 'name',
      message: 'missing',
    })
  })

  it('does not require frontmatter.name to match the folder name', () => {
    const content = ['---', 'name: pdf-processing', '---'].join('\n')
    const files = [{ relativePath: 'SKILL.md', content }]
    expect(validateDirectoryPackage('different-folder', files)).toEqual([])
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

  it('accepts a non-standard name without description', () => {
    const content = ['---', 'name: Any Name With Spaces', '---'].join('\n')
    expect(validateSingleFileSkill(content)).toEqual([])
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
})
