import { App } from 'obsidian'

import {
  humanizeSkillName,
  migrateVaultSkillFrontmatter,
  rewriteSkillFrontmatterIdToName,
} from './liteSkills'

describe('rewriteSkillFrontmatterIdToName', () => {
  it('promotes a valid string id to name and removes the id line', () => {
    const input = [
      '---',
      'id: english-polisher',
      'name: English Writing Polisher',
      'description: polish text',
      'mode: lazy',
      '---',
      '',
      '# Body',
      'content',
      '',
    ].join('\n')

    const output = rewriteSkillFrontmatterIdToName(input, 'english-polisher')

    expect(output).not.toBeNull()
    expect(output).toContain('name: english-polisher')
    expect(output).not.toMatch(/^id:/m)
    // Everything else preserved verbatim.
    expect(output).toContain('description: polish text')
    expect(output).toContain('mode: lazy')
    expect(output).toContain('# Body')
    expect(output).toContain('content')
  })

  it('trims the promoted id value', () => {
    const input = ['---', 'id:   spaced-id   ', 'name: Whatever', '---', 'body']
      .join('\n')
      .concat('\n')

    const output = rewriteSkillFrontmatterIdToName(input, '  spaced-id  ')

    expect(output).not.toBeNull()
    expect(output).toContain('name: spaced-id')
    expect(output).not.toMatch(/^id:/m)
  })

  it('inserts a name line when only id exists', () => {
    const input = ['---', 'id: only-id', 'description: d', '---', 'body'].join(
      '\n',
    )

    const output = rewriteSkillFrontmatterIdToName(input, 'only-id')

    expect(output).not.toBeNull()
    expect(output).toContain('name: only-id')
    expect(output).not.toMatch(/^id:/m)
    expect(output).toContain('description: d')
  })

  it('returns null when the parsed id is not a string (numeric/boolean id)', () => {
    const input = ['---', 'id: 123', 'name: Keep Me', '---', 'body'].join('\n')

    // `id: 123` parses to a number; the loader never treated it as an id, so the
    // file must be left untouched (its identity already lives in `name`).
    expect(rewriteSkillFrontmatterIdToName(input, 123)).toBeNull()
    expect(rewriteSkillFrontmatterIdToName(input, true)).toBeNull()
    expect(rewriteSkillFrontmatterIdToName(input, undefined)).toBeNull()
    expect(rewriteSkillFrontmatterIdToName(input, null)).toBeNull()
  })

  it('returns null for an empty / whitespace-only id', () => {
    const input = ['---', 'id: ""', 'name: Keep Me', '---', 'body'].join('\n')

    expect(rewriteSkillFrontmatterIdToName(input, '')).toBeNull()
    expect(rewriteSkillFrontmatterIdToName(input, '   ')).toBeNull()
  })

  it('returns null when there is no id line to promote (already migrated)', () => {
    const input = [
      '---',
      'name: english-polisher',
      'description: polish text',
      '---',
      'body',
    ].join('\n')

    // Even if a stray id value is passed, with no id line there is nothing to do.
    expect(
      rewriteSkillFrontmatterIdToName(input, 'english-polisher'),
    ).toBeNull()
  })

  it('returns null when there is no frontmatter at all', () => {
    expect(
      rewriteSkillFrontmatterIdToName('# Just a heading\n', 'x'),
    ).toBeNull()
    expect(rewriteSkillFrontmatterIdToName('', 'x')).toBeNull()
  })

  it('quotes unsafe YAML scalar names so the result stays valid YAML', () => {
    // A numeric-like string id must be quoted, else it would re-parse as a number.
    const numericLike = ['---', 'id: "123"', 'name: N', '---', 'b'].join('\n')
    expect(rewriteSkillFrontmatterIdToName(numericLike, '123')).toContain(
      'name: "123"',
    )

    // Special characters (colon, hash) must be quoted.
    const special = ['---', 'id: x', 'name: N', '---', 'b'].join('\n')
    expect(rewriteSkillFrontmatterIdToName(special, 'foo: bar')).toContain(
      'name: "foo: bar"',
    )

    // Real newlines in the id must be encoded, never break the single name line.
    const newline = ['---', 'id: x', 'name: N', '---', 'b'].join('\n')
    const out = rewriteSkillFrontmatterIdToName(newline, 'foo\nbar')
    expect(out).toContain('name: "foo\\nbar"')
    // The promoted name stays on a single physical line.
    const nameLines = (out as string)
      .split('\n')
      .filter((line) => line.startsWith('name:'))
    expect(nameLines).toHaveLength(1)
  })

  it('preserves CRLF newline style', () => {
    const input = ['---', 'id: skill-a', 'name: Skill A', '---', 'body'].join(
      '\r\n',
    )

    const output = rewriteSkillFrontmatterIdToName(input, 'skill-a')

    expect(output).not.toBeNull()
    expect(output).toContain('\r\n')
    // No lone LF (every LF is part of a CRLF pair).
    expect((output as string).split('\r\n').join('')).not.toContain('\n')
    expect(output).toContain('name: skill-a')
    expect(output).not.toMatch(/^id:/m)
  })

  it('is idempotent: running the result again yields null', () => {
    const input = [
      '---',
      'id: my-skill',
      'name: My Skill',
      'description: d',
      '---',
      'body',
    ].join('\n')

    const first = rewriteSkillFrontmatterIdToName(input, 'my-skill')
    expect(first).not.toBeNull()
    // Migrated content has no id line, so a second pass is a no-op.
    expect(
      rewriteSkillFrontmatterIdToName(first as string, 'my-skill'),
    ).toBeNull()
  })
})

type FakeFile = {
  path: string
  name: string
  extension: string
}

const makeFakeApp = (
  files: Array<{
    file: FakeFile
    content: string
    frontmatter?: Record<string, unknown>
  }>,
): {
  app: App
  reads: Record<string, string>
  modifies: Array<{ path: string; content: string }>
} => {
  const reads: Record<string, string> = {}
  const frontmatters: Record<string, Record<string, unknown> | undefined> = {}
  files.forEach(({ file, content, frontmatter }) => {
    reads[file.path] = content
    frontmatters[file.path] = frontmatter
  })
  const modifies: Array<{ path: string; content: string }> = []

  const app = {
    vault: {
      getMarkdownFiles: (): FakeFile[] => files.map((f) => f.file),
      read: (file: FakeFile) => Promise.resolve(reads[file.path]),
      modify: (file: FakeFile, content: string) => {
        reads[file.path] = content
        modifies.push({ path: file.path, content })
        return Promise.resolve()
      },
    },
    metadataCache: {
      getFileCache: (file: FakeFile) => ({
        frontmatter: frontmatters[file.path],
      }),
    },
  } as unknown as App

  return { app, reads, modifies }
}

describe('migrateVaultSkillFrontmatter', () => {
  const settings = { yolo: { baseDir: 'YOLO' } }

  it('rewrites files with a valid string id and skips the rest, idempotently', async () => {
    const withId = {
      file: { path: 'YOLO/skills/a.md', name: 'a.md', extension: 'md' },
      content: ['---', 'id: skill-a', 'name: Skill A', '---', 'body a'].join(
        '\n',
      ),
      frontmatter: { id: 'skill-a', name: 'Skill A' },
    }
    const withoutId = {
      file: { path: 'YOLO/skills/b.md', name: 'b.md', extension: 'md' },
      content: ['---', 'name: skill-b', '---', 'body b'].join('\n'),
      frontmatter: { name: 'skill-b' },
    }
    const emptyId = {
      file: { path: 'YOLO/skills/c.md', name: 'c.md', extension: 'md' },
      content: ['---', 'id: ""', 'name: keep-c', '---', 'body c'].join('\n'),
      frontmatter: { id: '', name: 'keep-c' },
    }
    const numericId = {
      file: { path: 'YOLO/skills/d.md', name: 'd.md', extension: 'md' },
      content: ['---', 'id: 123', 'name: keep-d', '---', 'body d'].join('\n'),
      frontmatter: { id: 123, name: 'keep-d' },
    }

    const { app, reads, modifies } = makeFakeApp([
      withId,
      withoutId,
      emptyId,
      numericId,
    ])

    await migrateVaultSkillFrontmatter(app, settings)

    // Only the file with a valid string id is rewritten.
    expect(modifies.map((m) => m.path)).toEqual(['YOLO/skills/a.md'])
    expect(reads['YOLO/skills/a.md']).toContain('name: skill-a')
    expect(reads['YOLO/skills/a.md']).not.toMatch(/^id:/m)
    expect(reads['YOLO/skills/b.md']).toBe(withoutId.content)
    expect(reads['YOLO/skills/c.md']).toBe(emptyId.content)
    expect(reads['YOLO/skills/d.md']).toBe(numericId.content)

    // Second run is a no-op (idempotent) even though the fake cache still
    // reports the old id — the rewrite bails when there is no id line.
    modifies.length = 0
    await migrateVaultSkillFrontmatter(app, settings)
    expect(modifies).toEqual([])
  })

  it('skips a file that fails to read without aborting the batch', async () => {
    const good = {
      file: { path: 'YOLO/skills/good.md', name: 'good.md', extension: 'md' },
      content: ['---', 'id: good', 'name: Good', '---', 'b'].join('\n'),
      frontmatter: { id: 'good', name: 'Good' },
    }
    const bad = {
      file: { path: 'YOLO/skills/bad.md', name: 'bad.md', extension: 'md' },
      content: ['---', 'id: bad', 'name: Bad', '---', 'b'].join('\n'),
      frontmatter: { id: 'bad', name: 'Bad' },
    }

    const { app, reads } = makeFakeApp([bad, good])
    // Make the bad file throw on read.
    ;(
      app.vault as unknown as { read: (file: FakeFile) => Promise<string> }
    ).read = (file: FakeFile) => {
      if (file.path === 'YOLO/skills/bad.md') {
        return Promise.reject(new Error('boom'))
      }
      return Promise.resolve(reads[file.path])
    }

    await migrateVaultSkillFrontmatter(app, settings)

    expect(reads['YOLO/skills/good.md']).toContain('name: good')
    expect(reads['YOLO/skills/good.md']).not.toMatch(/^id:/m)
  })
})

describe('humanizeSkillName', () => {
  it('converts kebab-case to Title Case', () => {
    expect(humanizeSkillName('english-polisher')).toBe('English Polisher')
    expect(humanizeSkillName('skill-creator')).toBe('Skill Creator')
  })

  it('handles single words and underscores/spaces', () => {
    expect(humanizeSkillName('notes')).toBe('Notes')
    expect(humanizeSkillName('meeting_notes')).toBe('Meeting Notes')
    expect(humanizeSkillName('  spaced  name ')).toBe('Spaced Name')
  })

  it('returns empty string for empty input', () => {
    expect(humanizeSkillName('')).toBe('')
    expect(humanizeSkillName('   ')).toBe('')
  })
})
