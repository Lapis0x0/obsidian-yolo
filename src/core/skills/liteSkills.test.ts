import { App, normalizePath } from 'obsidian'

import {
  type ModuleChatModeSkillSourceV1,
  configureModuleChatModeSkillSource,
  getLiteSkillDocument,
  getLiteSkillDocumentByPath,
  getManagedSkillScanDirs,
  getSkillScanDirs,
  humanizeSkillName,
  initializeLiteSkillRegistryService,
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

  it('does not migrate externally owned project skills', async () => {
    const external = {
      file: {
        path: '.claude/skills/external/SKILL.md',
        name: 'SKILL.md',
        extension: 'md',
      },
      content: ['---', 'id: external', 'name: External', '---'].join('\n'),
      frontmatter: { id: 'external', name: 'External' },
    }
    const { app, reads, modifies } = makeFakeApp([external])

    await migrateVaultSkillFrontmatter(app, settings)

    expect(modifies).toEqual([])
    expect(reads[external.file.path]).toBe(external.content)
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
  const vaultListeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const directoryListings = Object.fromEntries(
    Object.entries(listings).map(([path, listing]) => [
      normalizePath(path),
      {
        files: listing.files.map((file) => normalizePath(file)),
        folders: listing.folders.map((folder) => normalizePath(folder)),
      },
    ]),
  ) as Record<string, AdapterDirListing>

  const parentPath = (path: string) => {
    const slashIndex = path.lastIndexOf('/')
    return slashIndex === -1 ? '' : path.slice(0, slashIndex)
  }

  const adapter = {
    exists: (path: string) => {
      const normalized = normalizePath(path)
      return Promise.resolve(
        Boolean(directoryListings[normalized]) ||
          Object.prototype.hasOwnProperty.call(reads, normalized),
      )
    },
    list: (path: string) => {
      const listing = directoryListings[normalizePath(path)]
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
    mkdir: (path: string) => {
      const normalized = normalizePath(path)
      if (
        directoryListings[normalized] ||
        Object.prototype.hasOwnProperty.call(reads, normalized)
      ) {
        return Promise.reject(new Error(`already exists: ${normalized}`))
      }
      directoryListings[normalized] = { files: [], folders: [] }
      const parent = parentPath(normalized)
      const parentListing = directoryListings[parent]
      if (parentListing && !parentListing.folders.includes(normalized)) {
        parentListing.folders.push(normalized)
      }
      return Promise.resolve()
    },
    rename: (source: string, target: string) => {
      const normalizedSource = normalizePath(source)
      const normalizedTarget = normalizePath(target)
      if (!Object.prototype.hasOwnProperty.call(reads, normalizedSource)) {
        return Promise.reject(new Error(`missing source: ${normalizedSource}`))
      }
      if (
        Object.prototype.hasOwnProperty.call(reads, normalizedTarget) ||
        directoryListings[normalizedTarget]
      ) {
        return Promise.reject(new Error(`target exists: ${normalizedTarget}`))
      }
      reads[normalizedTarget] = reads[normalizedSource]
      Reflect.deleteProperty(reads, normalizedSource)
      const sourceParent = directoryListings[parentPath(normalizedSource)]
      if (sourceParent) {
        sourceParent.files = sourceParent.files.filter(
          (path) => path !== normalizedSource,
        )
      }
      const targetParent = directoryListings[parentPath(normalizedTarget)]
      targetParent?.files.push(normalizedTarget)
      return Promise.resolve()
    },
    rmdir: (path: string) => {
      const normalized = normalizePath(path)
      const listing = directoryListings[normalized]
      if (!listing || listing.files.length > 0 || listing.folders.length > 0) {
        return Promise.reject(new Error(`directory not empty: ${normalized}`))
      }
      Reflect.deleteProperty(directoryListings, normalized)
      const parent = directoryListings[parentPath(normalized)]
      if (parent) {
        parent.folders = parent.folders.filter((item) => item !== normalized)
      }
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
      on: (event: string, callback: (...args: unknown[]) => void) => {
        const callbacks = vaultListeners.get(event) ?? []
        callbacks.push(callback)
        vaultListeners.set(event, callbacks)
        return { event, callback }
      },
      offref: jest.fn(),
    },
    metadataCache: {
      getFileCache: (file: { path: string }) => ({
        frontmatter: fileFrontmatter[normalizePath(file.path)],
      }),
    },
  } as unknown as App

  ;(
    app as unknown as {
      emitVaultEvent: (event: string, ...args: unknown[]) => void
    }
  ).emitVaultEvent = (event, ...args) => {
    for (const callback of vaultListeners.get(event) ?? []) callback(...args)
  }
  ;(
    app as unknown as {
      setVaultListing: (path: string, listing: AdapterDirListing) => void
    }
  ).setVaultListing = (path, listing) => {
    directoryListings[normalizePath(path)] = {
      files: listing.files.map((file) => normalizePath(file)),
      folders: listing.folders.map((folder) => normalizePath(folder)),
    }
  }

  return app
}

describe('getSkillScanDirs', () => {
  it('keeps managed roots separate from read-only project roots', () => {
    const input = {
      settings: { yolo: { baseDir: `${OBSIDIAN_CONFIG_DIR}/yolo` } },
      configDir: OBSIDIAN_CONFIG_DIR,
    }
    expect(getManagedSkillScanDirs(input)).toEqual([
      `${OBSIDIAN_CONFIG_DIR}/yolo/skills`,
      `${OBSIDIAN_CONFIG_DIR}/skills`,
      `${OBSIDIAN_CONFIG_DIR}/YOLO/skills`,
    ])
    expect(getSkillScanDirs(input)).toEqual([
      `${OBSIDIAN_CONFIG_DIR}/yolo/skills`,
      `${OBSIDIAN_CONFIG_DIR}/skills`,
      `${OBSIDIAN_CONFIG_DIR}/YOLO/skills`,
      '.claude/skills',
      '.agents/skills',
      '.codex/skills',
    ])
  })
})

describe('listLiteSkillEntries and getLiteSkillDocument', () => {
  const settings = { yolo: { baseDir: 'YOLO' } }

  it('shares one inflight recursive scan across list/get callers', async () => {
    const app = makeAdapterApp({
      listings: {
        'YOLO/skills': {
          files: [],
          folders: ['YOLO/skills/shared'],
        },
        'YOLO/skills/shared': {
          files: ['YOLO/skills/shared/SKILL.md'],
          folders: [],
        },
      },
      fileContents: {
        'YOLO/skills/shared/SKILL.md': [
          '---',
          'name: shared',
          'description: shared registry',
          '---',
          'body',
        ].join('\n'),
      },
    })
    const listSpy = jest.spyOn(app.vault.adapter, 'list')

    const [firstList, document, secondList] = await Promise.all([
      listLiteSkillEntries(app, { settings }),
      getLiteSkillDocument({ app, name: 'shared', settings }),
      listLiteSkillEntries(app, { settings }),
    ])

    expect(firstList.map((entry) => entry.name)).toContain('shared')
    expect(secondList).toEqual(firstList)
    expect(document?.content).toContain('body')
    expect(listSpy).toHaveBeenCalledTimes(1)
  })

  it('invalidates and rebuilds after a relevant vault event', async () => {
    const app = makeAdapterApp({
      listings: {
        'YOLO/skills': {
          files: [],
          folders: ['YOLO/skills/first'],
        },
        'YOLO/skills/first': {
          files: ['YOLO/skills/first/SKILL.md'],
          folders: [],
        },
      },
      fileContents: {
        'YOLO/skills/first/SKILL.md': '---\nname: first\n---\n',
        'YOLO/skills/second/SKILL.md': '---\nname: second\n---\n',
      },
    })
    const dispose = initializeLiteSkillRegistryService({ app, settings })
    await listLiteSkillEntries(app, { settings })

    const setVaultListing = (
      app as unknown as {
        setVaultListing: (path: string, listing: AdapterDirListing) => void
      }
    ).setVaultListing
    setVaultListing('YOLO/skills', {
      files: [],
      folders: ['YOLO/skills/first', 'YOLO/skills/second'],
    })
    setVaultListing('YOLO/skills/second', {
      files: ['YOLO/skills/second/SKILL.md'],
      folders: [],
    })
    ;(
      app as unknown as {
        emitVaultEvent: (event: string, file: { path: string }) => void
      }
    ).emitVaultEvent('create', { path: 'YOLO/skills/second/SKILL.md' })

    await expect(listLiteSkillEntries(app, { settings })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'second' })]),
    )
    dispose()
  })

  it('coalesces bulk vault events into one background rebuild', async () => {
    jest.useFakeTimers()
    const app = makeAdapterApp({
      listings: {
        'YOLO/skills': {
          files: [],
          folders: ['YOLO/skills/first'],
        },
        'YOLO/skills/first': {
          files: ['YOLO/skills/first/SKILL.md'],
          folders: [],
        },
      },
      fileContents: {
        'YOLO/skills/first/SKILL.md': '---\nname: first\n---\n',
      },
    })
    const dispose = initializeLiteSkillRegistryService({ app, settings })
    const listSpy = jest.spyOn(app.vault.adapter, 'list')
    try {
      await listLiteSkillEntries(app, { settings })
      listSpy.mockClear()
      const emit = (
        app as unknown as {
          emitVaultEvent: (event: string, file: { path: string }) => void
        }
      ).emitVaultEvent

      emit('create', { path: 'YOLO/skills/a/SKILL.md' })
      emit('modify', { path: 'YOLO/skills/b/SKILL.md' })
      emit('delete', { path: 'YOLO/skills/c/SKILL.md' })
      expect(listSpy).not.toHaveBeenCalled()

      jest.runOnlyPendingTimers()
      await listLiteSkillEntries(app, { settings })
      expect(listSpy).toHaveBeenCalledTimes(1)
    } finally {
      dispose()
      jest.useRealTimers()
    }
  })

  it('rebuilds when the YOLO base directory changes', async () => {
    const app = makeAdapterApp({
      listings: {
        'YOLO/skills': { files: [], folders: ['YOLO/skills/old-base'] },
        'YOLO/skills/old-base': {
          files: ['YOLO/skills/old-base/SKILL.md'],
          folders: [],
        },
        'NEW/skills': { files: [], folders: ['NEW/skills/new-base'] },
        'NEW/skills/new-base': {
          files: ['NEW/skills/new-base/SKILL.md'],
          folders: [],
        },
      },
      fileContents: {
        'YOLO/skills/old-base/SKILL.md': '---\nname: old-base\n---\n',
        'NEW/skills/new-base/SKILL.md': '---\nname: new-base\n---\n',
      },
    })

    const before = await listLiteSkillEntries(app, { settings })
    const after = await listLiteSkillEntries(app, {
      settings: { yolo: { baseDir: 'NEW' } },
    })

    expect(before.map((entry) => entry.name)).toContain('old-base')
    expect(after.map((entry) => entry.name)).toContain('new-base')
    expect(after.map((entry) => entry.name)).not.toContain('old-base')
  })

  it('lists directory packages and root Markdown skills in default and hidden roots', async () => {
    const app = makeAdapterApp({
      listings: {
        'YOLO/skills': {
          files: ['YOLO/skills/legacy-root.md'],
          folders: ['YOLO/skills/default-skill'],
        },
        'YOLO/skills/default-skill': {
          files: ['YOLO/skills/default-skill/SKILL.md'],
          folders: [],
        },
        [`${OBSIDIAN_CONFIG_DIR}/skills`]: {
          files: [`${OBSIDIAN_CONFIG_DIR}/skills/legacy-hidden.markdown`],
          folders: [`${OBSIDIAN_CONFIG_DIR}/skills/hidden-skill`],
        },
        [`${OBSIDIAN_CONFIG_DIR}/skills/hidden-skill`]: {
          files: [`${OBSIDIAN_CONFIG_DIR}/skills/hidden-skill/SKILL.md`],
          folders: [],
        },
      },
      fileContents: {
        'YOLO/skills/default-skill/SKILL.md': [
          '---',
          'name: default-skill',
          'description: from default dir',
          '---',
          '',
        ].join('\n'),
        [`${OBSIDIAN_CONFIG_DIR}/skills/hidden-skill/SKILL.md`]: [
          '---',
          'name: hidden-skill',
          'description: from hidden dir',
          '---',
          '',
        ].join('\n'),
        'YOLO/skills/legacy-root.md': [
          '---',
          'name: legacy-root',
          'description: from default root',
          '---',
        ].join('\n'),
        [`${OBSIDIAN_CONFIG_DIR}/skills/legacy-hidden.markdown`]: [
          '---',
          'name: legacy-hidden',
          'description: from hidden root',
          '---',
        ].join('\n'),
      },
    })

    const entries = await listLiteSkillEntries(app, { settings })
    const names = entries.map((entry) => entry.name)

    expect(names).toContain('default-skill')
    expect(names).toContain('hidden-skill')
    expect(names).toContain('legacy-root')
    expect(names).toContain('legacy-hidden')
    expect(entries.find((entry) => entry.name === 'legacy-root')?.path).toBe(
      'YOLO/skills/legacy-root.md',
    )
  })

  it('prefers a directory package over a same-named root Markdown skill', async () => {
    const app = makeAdapterApp({
      listings: {
        'YOLO/skills': {
          files: ['YOLO/skills/readable-filename.md'],
          folders: ['YOLO/skills/standard-name'],
        },
        'YOLO/skills/standard-name': {
          files: ['YOLO/skills/standard-name/SKILL.md'],
          folders: [],
        },
      },
      fileContents: {
        'YOLO/skills/readable-filename.md': [
          '---',
          'name: standard-name',
          'description: legacy file',
          '---',
        ].join('\n'),
        'YOLO/skills/standard-name/SKILL.md': [
          '---',
          'name: standard-name',
          'description: package file',
          '---',
        ].join('\n'),
      },
    })

    const entries = await listLiteSkillEntries(app, { settings })

    expect(
      entries.find((entry) => entry.name === 'standard-name'),
    ).toMatchObject({
      path: 'YOLO/skills/standard-name/SKILL.md',
      description: 'package file',
    })
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

  it('discovers project-local Claude and Codex skills as read-only', async () => {
    const app = makeAdapterApp({
      listings: {
        'YOLO/skills': { files: [], folders: [] },
        '.claude/skills': {
          files: [],
          folders: ['.claude/skills/claude-skill'],
        },
        '.claude/skills/claude-skill': {
          files: ['.claude/skills/claude-skill/SKILL.md'],
          folders: [],
        },
        '.agents/skills': {
          files: [],
          folders: ['.agents/skills/codex-skill'],
        },
        '.agents/skills/codex-skill': {
          files: ['.agents/skills/codex-skill/SKILL.md'],
          folders: [],
        },
      },
      fileContents: {
        '.claude/skills/claude-skill/SKILL.md': [
          '---',
          'name: claude-skill',
          'description: Claude project skill',
          '---',
        ].join('\n'),
        '.agents/skills/codex-skill/SKILL.md': [
          '---',
          'name: codex-skill',
          'description: Codex project skill',
          '---',
        ].join('\n'),
      },
    })

    const entries = await listLiteSkillEntries(app, { settings })
    expect(
      entries
        .filter((entry) => ['claude-skill', 'codex-skill'].includes(entry.name))
        .map((entry) => ({ name: entry.name, isReadOnly: entry.isReadOnly })),
    ).toEqual(
      expect.arrayContaining([
        { name: 'claude-skill', isReadOnly: true },
        { name: 'codex-skill', isReadOnly: true },
      ]),
    )
  })

  it('prefers the default skills dir over hidden dirs for duplicate names', async () => {
    const app = makeAdapterApp({
      listings: {
        'YOLO/skills': {
          files: [],
          folders: ['YOLO/skills/shared-skill'],
        },
        'YOLO/skills/shared-skill': {
          files: ['YOLO/skills/shared-skill/SKILL.md'],
          folders: [],
        },
        [`${OBSIDIAN_CONFIG_DIR}/skills`]: {
          files: [],
          folders: [`${OBSIDIAN_CONFIG_DIR}/skills/shared-skill`],
        },
        [`${OBSIDIAN_CONFIG_DIR}/skills/shared-skill`]: {
          files: [`${OBSIDIAN_CONFIG_DIR}/skills/shared-skill/SKILL.md`],
          folders: [],
        },
      },
      fileContents: {
        'YOLO/skills/shared-skill/SKILL.md': [
          '---',
          'name: shared-skill',
          'description: default wins',
          '---',
          '',
        ].join('\n'),
        [`${OBSIDIAN_CONFIG_DIR}/skills/shared-skill/SKILL.md`]: [
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

    expect(shared?.path).toBe('YOLO/skills/shared-skill/SKILL.md')
    expect(shared?.description).toBe('default wins')
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
          files: [],
          folders: [`${OBSIDIAN_CONFIG_DIR}/skills/hidden-open`],
        },
        [`${OBSIDIAN_CONFIG_DIR}/skills/hidden-open`]: {
          files: [`${OBSIDIAN_CONFIG_DIR}/skills/hidden-open/SKILL.md`],
          folders: [],
        },
      },
      fileContents: {
        [`${OBSIDIAN_CONFIG_DIR}/skills/hidden-open/SKILL.md`]: content,
      },
    })

    const document = await getLiteSkillDocument({
      app,
      name: 'hidden-open',
      settings,
    })

    expect(document?.entry.path).toBe(
      `${OBSIDIAN_CONFIG_DIR}/skills/hidden-open/SKILL.md`,
    )
    expect(document?.content).toBe(content)
  })

  it('ignores nested packages but accepts a folder-name mismatch', async () => {
    const app = makeAdapterApp({
      listings: {
        'YOLO/skills': {
          files: [],
          folders: ['YOLO/skills/group', 'YOLO/skills/wrong-folder'],
        },
        'YOLO/skills/group': {
          files: [],
          folders: ['YOLO/skills/group/nested-skill'],
        },
        'YOLO/skills/group/nested-skill': {
          files: ['YOLO/skills/group/nested-skill/SKILL.md'],
          folders: [],
        },
        'YOLO/skills/wrong-folder': {
          files: ['YOLO/skills/wrong-folder/SKILL.md'],
          folders: [],
        },
      },
      fileContents: {
        'YOLO/skills/group/nested-skill/SKILL.md': [
          '---',
          'name: nested-skill',
          'description: nested too deeply',
          '---',
        ].join('\n'),
        'YOLO/skills/wrong-folder/SKILL.md': [
          '---',
          'name: Other Name',
          '---',
        ].join('\n'),
      },
    })

    const names = (await listLiteSkillEntries(app, { settings })).map(
      (entry) => entry.name,
    )
    expect(names).not.toContain('nested-skill')
    expect(names).toContain('Other Name')
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

describe('module chat mode skill scope', () => {
  const settings = { yolo: { baseDir: 'YOLO' } }
  const MODE_ID = 'module:learning:chat'
  const DECLARED_SKILL = 'skills/outline-skill/SKILL.md'
  // Where the activation-time projection writes the module's package.
  const SKILL_PATH = 'YOLO/modules/learning/skills/outline-skill/SKILL.md'

  afterEach(() => {
    configureModuleChatModeSkillSource(null)
  })

  const makeSource = (
    overrides: Partial<ModuleChatModeSkillSourceV1> = {},
  ): ModuleChatModeSkillSourceV1 => ({
    getMode: (fullModeId) =>
      fullModeId === MODE_ID
        ? { moduleId: 'learning', skillPaths: [DECLARED_SKILL] }
        : undefined,
    listModeIds: () => [MODE_ID],
    resolveSkillPath: (moduleId, declaredSkillPath) =>
      moduleId === 'learning' && declaredSkillPath === DECLARED_SKILL
        ? SKILL_PATH
        : null,
    ...overrides,
  })

  it('is a no-op when unconfigured: scope is accepted but changes nothing', async () => {
    const app = makeAdapterApp({
      listings: { 'YOLO/skills': { files: [], folders: [] } },
      fileContents: {},
    })

    const scoped = await listLiteSkillEntries(app, {
      settings,
      scope: { moduleChatModeId: MODE_ID },
    })
    const unscoped = await listLiteSkillEntries(app, { settings })

    // Only builtins (seeded unconditionally) — no `outline-skill` from an
    // unconfigured module source, and scoped/unscoped are identical.
    expect(scoped.map((entry) => entry.name)).not.toContain('outline-skill')
    expect(scoped).toEqual(unscoped)
  })

  it('adds the mode-scoped skill to listLiteSkillEntries only when scope matches', async () => {
    configureModuleChatModeSkillSource(makeSource())
    const app = makeAdapterApp({
      listings: { 'YOLO/skills': { files: [], folders: [] } },
      fileContents: {
        [SKILL_PATH]: [
          '---',
          'name: outline-skill',
          'description: Outline design conventions',
          '---',
          'body',
        ].join('\n'),
      },
    })

    const scoped = await listLiteSkillEntries(app, {
      settings,
      scope: { moduleChatModeId: MODE_ID },
    })
    expect(scoped.map((entry) => entry.name)).toContain('outline-skill')
    const scopedEntry = scoped.find((entry) => entry.name === 'outline-skill')
    expect(scopedEntry?.isReadOnly).toBe(true)

    const unscoped = await listLiteSkillEntries(app, { settings })
    expect(unscoped.map((entry) => entry.name)).not.toContain('outline-skill')

    const otherMode = await listLiteSkillEntries(app, {
      settings,
      scope: { moduleChatModeId: 'module:learning:other' },
    })
    expect(otherMode.map((entry) => entry.name)).not.toContain('outline-skill')
  })

  it('lets a same-named user/global vault skill win over the mode skill', async () => {
    configureModuleChatModeSkillSource(makeSource())
    const app = makeAdapterApp({
      listings: {
        'YOLO/skills': {
          files: [],
          folders: ['YOLO/skills/outline-skill'],
        },
        'YOLO/skills/outline-skill': {
          files: ['YOLO/skills/outline-skill/SKILL.md'],
          folders: [],
        },
      },
      fileContents: {
        'YOLO/skills/outline-skill/SKILL.md': [
          '---',
          'name: outline-skill',
          'description: user override',
          '---',
          'user body',
        ].join('\n'),
        [SKILL_PATH]: [
          '---',
          'name: outline-skill',
          'description: module version',
          '---',
          'module body',
        ].join('\n'),
      },
    })

    const scoped = await listLiteSkillEntries(app, {
      settings,
      scope: { moduleChatModeId: MODE_ID },
    })

    const outlineEntries = scoped.filter(
      (entry) => entry.name === 'outline-skill',
    )
    expect(outlineEntries).toHaveLength(1)
    expect(outlineEntries[0].path).toBe('YOLO/skills/outline-skill/SKILL.md')
    expect(outlineEntries[0].isReadOnly).toBe(false)
  })

  it('getLiteSkillDocument resolves a mode-scoped skill by name', async () => {
    configureModuleChatModeSkillSource(makeSource())
    const app = makeAdapterApp({
      listings: { 'YOLO/skills': { files: [], folders: [] } },
      fileContents: {
        [SKILL_PATH]: ['---', 'name: outline-skill', '---', 'module body'].join(
          '\n',
        ),
      },
    })

    const withScope = await getLiteSkillDocument({
      app,
      name: 'outline-skill',
      settings,
      scope: { moduleChatModeId: MODE_ID },
    })
    expect(withScope?.content).toContain('module body')

    const withoutScope = await getLiteSkillDocument({
      app,
      name: 'outline-skill',
      settings,
    })
    expect(withoutScope).toBeNull()
  })

  it('getLiteSkillDocumentByPath finds a mode skill by path even without an explicit scope', async () => {
    configureModuleChatModeSkillSource(makeSource())
    const app = makeAdapterApp({
      listings: { 'YOLO/skills': { files: [], folders: [] } },
      fileContents: {
        [SKILL_PATH]: ['---', 'name: outline-skill', '---', 'module body'].join(
          '\n',
        ),
      },
    })

    const document = await getLiteSkillDocumentByPath({
      app,
      path: SKILL_PATH,
      settings,
    })

    expect(document?.entry.name).toBe('outline-skill')
    expect(document?.content).toContain('module body')
  })

  it('skips a declared skill whose file name does not resolve, without throwing', async () => {
    configureModuleChatModeSkillSource(
      makeSource({
        getMode: (fullModeId) =>
          fullModeId === MODE_ID
            ? {
                moduleId: 'learning',
                skillPaths: ['skills/missing/SKILL.md', DECLARED_SKILL],
              }
            : undefined,
      }),
    )
    const app = makeAdapterApp({
      listings: { 'YOLO/skills': { files: [], folders: [] } },
      fileContents: {
        [SKILL_PATH]: ['---', 'name: outline-skill', '---', 'body'].join('\n'),
      },
    })

    const entries = await listLiteSkillEntries(app, {
      settings,
      scope: { moduleChatModeId: MODE_ID },
    })

    expect(entries.map((entry) => entry.name)).toContain('outline-skill')
    expect(entries.map((entry) => entry.name)).not.toContain('missing-skill')
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
