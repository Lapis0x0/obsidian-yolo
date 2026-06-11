import { App, normalizePath } from 'obsidian'

import {
  getLiteSkillDocument,
  getLiteSkillDocumentByPath,
  getSkillScanDirs,
  humanizeSkillName,
  listLiteSkillEntries,
  migrateVaultSkillFrontmatter,
  rewriteSkillFrontmatterIdToName,
} from './liteSkills'

const OBSIDIAN_CONFIG_DIR = ['.', 'obsidian'].join('')

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
  const fileByPath = new Map(files.map(({ file }) => [file.path, file]))
  const filesByDir = new Map<string, string[]>()
  for (const { file } of files) {
    const slashIndex = file.path.lastIndexOf('/')
    const dir = slashIndex === -1 ? '' : file.path.slice(0, slashIndex)
    const entries = filesByDir.get(dir) ?? []
    entries.push(file.path)
    filesByDir.set(dir, entries)
  }

  const vault = {
    adapter: {
      exists: (path: string) => Promise.resolve(filesByDir.has(path)),
      list: (path: string) =>
        Promise.resolve({
          files: filesByDir.get(path) ?? [],
          folders: [],
        }),
    },
    getMarkdownFiles: (): FakeFile[] => files.map((f) => f.file),
    getFileByPath: (path: string): FakeFile | null =>
      fileByPath.get(path) ?? null,
    read: (file: FakeFile) => Promise.resolve(reads[file.path]),
    cachedRead: (file: FakeFile) => vault.read(file),
    modify: (file: FakeFile, content: string) => {
      reads[file.path] = content
      modifies.push({ path: file.path, content })
      return Promise.resolve()
    },
  }

  const app = {
    vault,
    metadataCache: {
      getFileCache: (file: FakeFile) => ({
        frontmatter: frontmatters[file.path],
      }),
    },
  } as unknown as App

  ;(app.vault as unknown as { configDir: string }).configDir =
    OBSIDIAN_CONFIG_DIR

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

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await migrateVaultSkillFrontmatter(app, settings)
    } finally {
      warnSpy.mockRestore()
    }

    expect(reads['YOLO/skills/good.md']).toContain('name: good')
    expect(reads['YOLO/skills/good.md']).not.toMatch(/^id:/m)
  })
})

type AdapterDirListing = {
  files: string[]
  folders: string[]
}

const makeAdapterApp = ({
  listings,
  fileContents,
  fileFrontmatter = {},
  fileByPath = {},
}: {
  listings: Record<string, AdapterDirListing>
  fileContents: Record<string, string>
  fileFrontmatter?: Record<string, Record<string, unknown>>
  fileByPath?: Record<string, { path: string; name: string; extension: string }>
}): App => {
  const reads = { ...fileContents }
  const writes: Array<{ path: string; content: string }> = []

  const adapter = {
    exists: (path: string) =>
      Promise.resolve(Boolean(listings[normalizePath(path)])),
    list: (path: string) => {
      const listing = listings[normalizePath(path)]
      if (!listing) {
        return Promise.resolve({ files: [], folders: [] })
      }
      return Promise.resolve({
        files: listing.files.map((file) => normalizePath(file)),
        folders: listing.folders.map((folder) => normalizePath(folder)),
      })
    },
    read: (path: string) => Promise.resolve(reads[normalizePath(path)] ?? ''),
    write: (path: string, content: string) => {
      const normalized = normalizePath(path)
      reads[normalized] = content
      writes.push({ path: normalized, content })
      return Promise.resolve()
    },
  }

  const app = {
    vault: {
      configDir: OBSIDIAN_CONFIG_DIR,
      adapter,
      getFileByPath: (path: string) => fileByPath[normalizePath(path)] ?? null,
      cachedRead: (file: { path: string }) =>
        Promise.resolve(reads[normalizePath(file.path)] ?? ''),
      read: (file: { path: string }) =>
        Promise.resolve(reads[normalizePath(file.path)] ?? ''),
      modify: (file: { path: string }, content: string) => {
        const normalized = normalizePath(file.path)
        reads[normalized] = content
        writes.push({ path: normalized, content })
        return Promise.resolve()
      },
    },
    metadataCache: {
      getFileCache: (file: { path: string }) => ({
        frontmatter: fileFrontmatter[normalizePath(file.path)],
      }),
    },
  } as unknown as App

  return app
}

describe('getSkillScanDirs', () => {
  it('deduplicates the default skills dir when it matches a hidden root', () => {
    expect(
      getSkillScanDirs({
        settings: { yolo: { baseDir: `${OBSIDIAN_CONFIG_DIR}/yolo` } },
        configDir: OBSIDIAN_CONFIG_DIR,
      }),
    ).toEqual([
      `${OBSIDIAN_CONFIG_DIR}/yolo/skills`,
      `${OBSIDIAN_CONFIG_DIR}/skills`,
      `${OBSIDIAN_CONFIG_DIR}/YOLO/skills`,
    ])
  })
})

describe('listLiteSkillEntries and getLiteSkillDocument', () => {
  const settings = { yolo: { baseDir: 'YOLO' } }

  it('lists default-dir and hidden-dir skills via adapter scan', async () => {
    const app = makeAdapterApp({
      listings: {
        'YOLO/skills': {
          files: ['YOLO/skills/default-skill.md'],
          folders: [],
        },
        [`${OBSIDIAN_CONFIG_DIR}/skills`]: {
          files: [`${OBSIDIAN_CONFIG_DIR}/skills/hidden-skill.md`],
          folders: [],
        },
      },
      fileContents: {
        'YOLO/skills/default-skill.md': [
          '---',
          'name: default-skill',
          'description: from default dir',
          '---',
          '',
        ].join('\n'),
        [`${OBSIDIAN_CONFIG_DIR}/skills/hidden-skill.md`]: [
          '---',
          'name: hidden-skill',
          'description: from hidden dir',
          '---',
          '',
        ].join('\n'),
      },
    })

    const entries = await listLiteSkillEntries(app, { settings })
    const names = entries.map((entry) => entry.name)

    expect(names).toContain('default-skill')
    expect(names).toContain('hidden-skill')
  })

  it('discovers Claude-style SKILL.md under hidden directories', async () => {
    const app = makeAdapterApp({
      listings: {
        'YOLO/skills': { files: [], folders: [] },
        [`${OBSIDIAN_CONFIG_DIR}/skills`]: {
          files: [],
          folders: [`${OBSIDIAN_CONFIG_DIR}/skills/claude-skill`],
        },
        [`${OBSIDIAN_CONFIG_DIR}/skills/claude-skill`]: {
          files: [`${OBSIDIAN_CONFIG_DIR}/skills/claude-skill/SKILL.md`],
          folders: [],
        },
      },
      fileContents: {
        [`${OBSIDIAN_CONFIG_DIR}/skills/claude-skill/SKILL.md`]: [
          '---',
          'name: claude-skill',
          'description: nested skill',
          '---',
          '',
        ].join('\n'),
      },
    })

    const entries = await listLiteSkillEntries(app, { settings })
    expect(entries.map((entry) => entry.name)).toContain('claude-skill')
  })

  it('prefers the default skills dir over hidden dirs for duplicate names', async () => {
    const app = makeAdapterApp({
      listings: {
        'YOLO/skills': {
          files: ['YOLO/skills/shared-skill.md'],
          folders: [],
        },
        [`${OBSIDIAN_CONFIG_DIR}/skills`]: {
          files: [`${OBSIDIAN_CONFIG_DIR}/skills/shared-skill.md`],
          folders: [],
        },
      },
      fileContents: {
        'YOLO/skills/shared-skill.md': [
          '---',
          'name: shared-skill',
          'description: default wins',
          '---',
          '',
        ].join('\n'),
        [`${OBSIDIAN_CONFIG_DIR}/skills/shared-skill.md`]: [
          '---',
          'name: shared-skill',
          'description: hidden loses',
          '---',
          '',
        ].join('\n'),
      },
    })

    const entries = await listLiteSkillEntries(app, { settings })
    const shared = entries.find((entry) => entry.name === 'shared-skill')

    expect(shared?.path).toBe('YOLO/skills/shared-skill.md')
    expect(shared?.description).toBe('default wins')
  })

  it('uses path order within the same directory for duplicate names', async () => {
    const app = makeAdapterApp({
      listings: {
        'YOLO/skills': {
          files: ['YOLO/skills/b-skill.md', 'YOLO/skills/a-skill.md'],
          folders: [],
        },
        [`${OBSIDIAN_CONFIG_DIR}/skills`]: { files: [], folders: [] },
      },
      fileContents: {
        'YOLO/skills/a-skill.md': [
          '---',
          'name: same-name',
          'description: first by path',
          '---',
          '',
        ].join('\n'),
        'YOLO/skills/b-skill.md': [
          '---',
          'name: same-name',
          'description: second by path',
          '---',
          '',
        ].join('\n'),
      },
    })

    const entries = await listLiteSkillEntries(app, { settings })
    const winner = entries.find((entry) => entry.name === 'same-name')

    expect(winner?.path).toBe('YOLO/skills/a-skill.md')
    expect(winner?.description).toBe('first by path')
  })

  it('opens a hidden-directory skill through the shared registry', async () => {
    const content = [
      '---',
      'name: hidden-open',
      'description: hidden body',
      '---',
      '# Hidden body',
    ].join('\n')
    const app = makeAdapterApp({
      listings: {
        'YOLO/skills': { files: [], folders: [] },
        [`${OBSIDIAN_CONFIG_DIR}/skills`]: {
          files: [`${OBSIDIAN_CONFIG_DIR}/skills/hidden-open.md`],
          folders: [],
        },
      },
      fileContents: {
        [`${OBSIDIAN_CONFIG_DIR}/skills/hidden-open.md`]: content,
      },
    })

    const document = await getLiteSkillDocument({
      app,
      name: 'hidden-open',
      settings,
    })

    expect(document?.entry.path).toBe(
      `${OBSIDIAN_CONFIG_DIR}/skills/hidden-open.md`,
    )
    expect(document?.content).toBe(content)
  })

  it('resolves builtin skill documents by canonical path', async () => {
    const app = makeAdapterApp({
      listings: {
        'YOLO/skills': { files: [], folders: [] },
      },
      fileContents: {},
    })

    const document = await getLiteSkillDocumentByPath({
      app,
      path: 'builtin://skills/skill-creator.md',
      settings,
    })

    expect(document?.entry.name).toBe('skill-creator')
    expect(document?.content).toContain('YOLO/skills')
  })
})

describe('migrateVaultSkillFrontmatter hidden dirs', () => {
  it('migrates legacy id frontmatter in hidden skill directories', async () => {
    const hiddenPath = `${OBSIDIAN_CONFIG_DIR}/skills/legacy-hidden.md`
    const initial = [
      '---',
      'id: legacy-hidden',
      'name: Legacy Hidden',
      '---',
      'body',
    ].join('\n')

    const app = makeAdapterApp({
      listings: {
        'YOLO/skills': { files: [], folders: [] },
        [`${OBSIDIAN_CONFIG_DIR}/skills`]: {
          files: [hiddenPath],
          folders: [],
        },
      },
      fileContents: {
        [hiddenPath]: initial,
      },
      fileFrontmatter: {
        [hiddenPath]: { id: 'legacy-hidden', name: 'Legacy Hidden' },
      },
    })

    await migrateVaultSkillFrontmatter(app, { yolo: { baseDir: 'YOLO' } })

    const adapter = app.vault.adapter as unknown as {
      read: (path: string) => Promise<string>
    }
    const migrated = await adapter.read(hiddenPath)

    expect(migrated).toContain('name: legacy-hidden')
    expect(migrated).not.toMatch(/^id:/m)
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
