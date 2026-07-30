import {
  type App,
  FileSystemAdapter,
  type ListedFiles,
  Platform,
  type Stat,
} from 'obsidian'

import type { LiteSkillPackageSource } from '../../skills/liteSkills'

import { ClaudeLocalPluginCache } from './plugin-cache'

const CONFIG_DIR = ['.', 'obsidian'].join('')

const encode = (value: string): ArrayBuffer =>
  new TextEncoder().encode(value).buffer

class MemoryFileSystemAdapter extends FileSystemAdapter {
  private readonly files = new Map<string, string | ArrayBuffer>()
  private readonly folders = new Set<string>()
  readonly writeBinaryCalls: string[] = []

  constructor(private readonly basePath = '/vault') {
    super()
  }

  getName(): string {
    return 'memory'
  }

  getBasePath(): string {
    return this.basePath
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path)
  }

  async stat(path: string): Promise<Stat | null> {
    const value = this.files.get(path)
    if (value !== undefined) {
      return {
        type: 'file',
        ctime: 0,
        mtime: 0,
        size: typeof value === 'string' ? value.length : value.byteLength,
      }
    }
    if (this.folders.has(path)) {
      return { type: 'folder', ctime: 0, mtime: 0, size: 0 }
    }
    return null
  }

  async list(path: string): Promise<ListedFiles> {
    const prefix = path ? `${path}/` : ''
    const directChild = (candidate: string): boolean =>
      candidate.startsWith(prefix) &&
      candidate !== path &&
      !candidate.slice(prefix.length).includes('/')
    return {
      files: [...this.files.keys()].filter(directChild).sort(),
      folders: [...this.folders].filter(directChild).sort(),
    }
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path)
    if (typeof value !== 'string') throw new Error(`Not text: ${path}`)
    return value
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const value = this.files.get(path)
    if (!(value instanceof ArrayBuffer)) throw new Error(`Not binary: ${path}`)
    return value.slice(0)
  }

  async write(path: string, value: string): Promise<void> {
    await this.ensureParent(path)
    this.files.set(path, value)
  }

  async writeBinary(path: string, value: ArrayBuffer): Promise<void> {
    await this.ensureParent(path)
    this.files.set(path, value.slice(0))
    this.writeBinaryCalls.push(path)
  }

  async mkdir(path: string): Promise<void> {
    const segments = path.split('/').filter(Boolean)
    let current = ''
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment
      this.folders.add(current)
    }
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path)
  }

  async rmdir(path: string, recursive: boolean): Promise<void> {
    const prefix = `${path}/`
    if (
      !recursive &&
      ([...this.files.keys()].some((entry) => entry.startsWith(prefix)) ||
        [...this.folders].some((entry) => entry.startsWith(prefix)))
    ) {
      throw new Error(`Directory is not empty: ${path}`)
    }
    for (const file of [...this.files.keys()]) {
      if (file.startsWith(prefix)) this.files.delete(file)
    }
    for (const folder of [...this.folders]) {
      if (folder === path || folder.startsWith(prefix)) {
        this.folders.delete(folder)
      }
    }
  }

  async rename(from: string, to: string): Promise<void> {
    if (await this.exists(to)) throw new Error(`Target exists: ${to}`)
    const move = (path: string) =>
      path === from ? to : `${to}${path.slice(from.length)}`
    for (const [path, value] of [...this.files]) {
      if (path === from || path.startsWith(`${from}/`)) {
        this.files.delete(path)
        this.files.set(move(path), value)
      }
    }
    for (const path of [...this.folders]) {
      if (path === from || path.startsWith(`${from}/`)) {
        this.folders.delete(path)
        this.folders.add(move(path))
      }
    }
  }

  async seedBinary(path: string, value: ArrayBuffer): Promise<void> {
    await this.ensureParent(path)
    this.files.set(path, value.slice(0))
  }

  async seedText(path: string, value: string): Promise<void> {
    await this.write(path, value)
  }

  getBytes(path: string): number[] {
    const value = this.files.get(path)
    if (!(value instanceof ArrayBuffer)) throw new Error(`Not binary: ${path}`)
    return [...new Uint8Array(value)]
  }

  private async ensureParent(path: string): Promise<void> {
    const index = path.lastIndexOf('/')
    if (index > 0) await this.mkdir(path.slice(0, index))
  }
}

const createApp = (adapter: object): App =>
  ({
    vault: {
      adapter,
      configDir: CONFIG_DIR,
    },
  }) as unknown as App

const source = (
  name: string,
  resources: LiteSkillPackageSource['resources'],
): LiteSkillPackageSource => ({
  entry: {
    name,
    description: `${name} description`,
    mode: 'lazy',
    path: `source://${name}/SKILL.md`,
  },
  resources,
})

describe('ClaudeLocalPluginCache', () => {
  const originalDesktop = Platform.isDesktop

  afterEach(() => {
    Platform.isDesktop = originalDesktop
  })

  it('materializes enabled packages completely and deterministically reuses them', async () => {
    const adapter = new MemoryFileSystemAdapter()
    await adapter.seedBinary(
      'sources/alpha/SKILL.md',
      encode('---\nname: alpha\ndescription: Alpha\n---\n'),
    )
    await adapter.seedBinary(
      'sources/alpha/assets/nested/icon.bin',
      new Uint8Array([0, 255, 1, 128]).buffer,
    )
    const packages = new Map([
      [
        'alpha',
        source('alpha', [
          {
            kind: 'vault',
            relativePath: 'SKILL.md',
            path: 'sources/alpha/SKILL.md',
          },
          {
            kind: 'vault',
            relativePath: 'assets/nested/icon.bin',
            path: 'sources/alpha/assets/nested/icon.bin',
          },
        ]),
      ],
      [
        'beta',
        source('beta', [
          {
            kind: 'builtin',
            relativePath: 'SKILL.md',
            content: '---\nname: beta\ndescription: Beta\n---\n',
          },
        ]),
      ],
    ])
    const getSkillPackageSource = jest.fn(
      async ({ name }: { name?: string }) =>
        name ? (packages.get(name) ?? null) : null,
    )
    const cache = new ClaudeLocalPluginCache({
      app: createApp(adapter),
      getSettings: () => ({ yolo: { baseDir: 'Custom' } }),
      getSkillPackageSource,
    })

    const first = await cache.resolvePluginPaths({
      assistantId: 'assistant-1',
      enabledSkillNames: ['beta', 'alpha'],
    })
    const writesAfterFirst = adapter.writeBinaryCalls.length
    const second = await cache.resolvePluginPaths({
      enabledSkillNames: ['alpha', 'beta', 'alpha'],
    })

    expect(second).toEqual(first)
    expect(first[0]).toMatch(
      /^\/vault\/Custom\/\.derived\/claude-plugins\/[a-f0-9]{64}$/,
    )
    expect(adapter.writeBinaryCalls).toHaveLength(writesAfterFirst)
    const relativeRoot = first[0].slice('/vault/'.length)
    expect(
      adapter.getBytes(`${relativeRoot}/skills/alpha/assets/nested/icon.bin`),
    ).toEqual([0, 255, 1, 128])
    expect(
      new TextDecoder().decode(
        new Uint8Array(
          await adapter.readBinary(`${relativeRoot}/skills/beta/SKILL.md`),
        ),
      ),
    ).toContain('name: beta')
    expect(
      JSON.parse(
        await adapter.read(`${relativeRoot}/.claude-plugin/plugin.json`),
      ),
    ).toMatchObject({
      name: expect.stringMatching(/^yolo-enabled-skills-[a-f0-9]{12}$/),
      version: '1.0.0',
      description: expect.any(String),
    })
    expect(
      getSkillPackageSource.mock.calls.map(([input]) => input.name),
    ).toEqual(['alpha', 'beta', 'alpha', 'beta'])
  })

  it('resolves only enabled names and reports all missing enabled skills', async () => {
    const adapter = new MemoryFileSystemAdapter()
    const getSkillPackageSource = jest.fn(
      async ({ name }: { name?: string }) =>
        name === 'alpha'
          ? source('alpha', [
              {
                kind: 'builtin',
                relativePath: 'SKILL.md',
                content: 'alpha',
              },
            ])
          : null,
    )
    const cache = new ClaudeLocalPluginCache({
      app: createApp(adapter),
      getSettings: () => undefined,
      getSkillPackageSource,
    })

    await expect(
      cache.resolvePluginPaths({
        enabledSkillNames: ['missing-b', 'alpha', 'missing-a'],
      }),
    ).rejects.toThrow('missing-a, missing-b')
    expect(
      getSkillPackageSource.mock.calls.map(([input]) => input.name),
    ).toEqual(['alpha', 'missing-a', 'missing-b'])
  })

  it.each([
    ['traversal', ['SKILL.md', '../outside.md']],
    [
      'case-insensitive collision',
      ['SKILL.md', 'docs/Guide.md', 'docs/guide.md'],
    ],
    ['file-directory collision', ['SKILL.md', 'docs', 'docs/guide.md']],
  ])('rejects %s resource paths', async (_label, relativePaths) => {
    const adapter = new MemoryFileSystemAdapter()
    const cache = new ClaudeLocalPluginCache({
      app: createApp(adapter),
      getSettings: () => undefined,
      getSkillPackageSource: async () =>
        source(
          'alpha',
          relativePaths.map((relativePath) => ({
            kind: 'builtin',
            relativePath,
            content: relativePath,
          })) as unknown as LiteSkillPackageSource['resources'],
        ),
    })

    await expect(
      cache.resolvePluginPaths({ enabledSkillNames: ['alpha'] }),
    ).rejects.toThrow(/Unsafe|collision/)
  })

  it('rejects a resolved package whose canonical name collides with the request', async () => {
    const adapter = new MemoryFileSystemAdapter()
    const cache = new ClaudeLocalPluginCache({
      app: createApp(adapter),
      getSettings: () => undefined,
      getSkillPackageSource: async () =>
        source('beta', [
          { kind: 'builtin', relativePath: 'SKILL.md', content: 'beta' },
        ]),
    })

    await expect(
      cache.resolvePluginPaths({ enabledSkillNames: ['alpha'] }),
    ).rejects.toThrow(/name collision/)
  })

  it('cleans only stale cache entries carrying a matching ownership marker', async () => {
    const adapter = new MemoryFileSystemAdapter()
    const staleHash = 'a'.repeat(64)
    const unownedHash = 'b'.repeat(64)
    const root = 'YOLO/.derived/claude-plugins'
    await adapter.seedText(
      `${root}/${staleHash}/.yolo-derived-plugin.json`,
      `${JSON.stringify({ version: 1, contentHash: staleHash })}\n`,
    )
    await adapter.seedText(`${root}/${staleHash}/old.txt`, 'old')
    await adapter.seedText(`${root}/${unownedHash}/keep.txt`, 'user data')
    const cache = new ClaudeLocalPluginCache({
      app: createApp(adapter),
      getSettings: () => undefined,
      getSkillPackageSource: async () =>
        source('alpha', [
          { kind: 'builtin', relativePath: 'SKILL.md', content: 'alpha' },
        ]),
    })

    await cache.resolvePluginPaths({ enabledSkillNames: ['alpha'] })

    expect(await adapter.exists(`${root}/${staleHash}`)).toBe(false)
    expect(await adapter.exists(`${root}/${unownedHash}/keep.txt`)).toBe(true)
  })

  it('keeps every cache hash resolved during the current process lifetime', async () => {
    const adapter = new MemoryFileSystemAdapter()
    const cache = new ClaudeLocalPluginCache({
      app: createApp(adapter),
      getSettings: () => undefined,
      getSkillPackageSource: async ({ name }) =>
        name
          ? source(name, [
              {
                kind: 'builtin',
                relativePath: 'SKILL.md',
                content: `skill:${name}`,
              },
            ])
          : null,
    })

    const first = await cache.resolvePluginPaths({
      enabledSkillNames: ['alpha'],
    })
    const second = await cache.resolvePluginPaths({
      enabledSkillNames: ['beta'],
    })

    expect(second).not.toEqual(first)
    expect(await adapter.exists(first[0].slice('/vault/'.length))).toBe(true)
    expect(await adapter.exists(second[0].slice('/vault/'.length))).toBe(true)
  })

  it('cleans owned stale staging while preserving unowned staging', async () => {
    const adapter = new MemoryFileSystemAdapter()
    const ownedHash = 'c'.repeat(64)
    const unownedHash = 'd'.repeat(64)
    const root = 'YOLO/.derived/claude-plugins'
    const ownedStaging = `${root}/.staging-${ownedHash}`
    const unownedStaging = `${root}/.staging-${unownedHash}`
    await adapter.seedText(
      `${ownedStaging}/.yolo-derived-plugin.json`,
      `${JSON.stringify({ version: 1, contentHash: ownedHash })}\n`,
    )
    await adapter.seedText(`${ownedStaging}/old.txt`, 'old')
    await adapter.seedText(`${unownedStaging}/keep.txt`, 'user data')
    const cache = new ClaudeLocalPluginCache({
      app: createApp(adapter),
      getSettings: () => undefined,
      getSkillPackageSource: async () =>
        source('alpha', [
          { kind: 'builtin', relativePath: 'SKILL.md', content: 'alpha' },
        ]),
    })

    await cache.resolvePluginPaths({ enabledSkillNames: ['alpha'] })

    expect(await adapter.exists(ownedStaging)).toBe(false)
    expect(await adapter.exists(`${unownedStaging}/keep.txt`)).toBe(true)
  })

  it('refuses to replace an unowned staging directory for the current hash', async () => {
    const adapter = new MemoryFileSystemAdapter()
    const cache = new ClaudeLocalPluginCache({
      app: createApp(adapter),
      getSettings: () => undefined,
      getSkillPackageSource: async () =>
        source('alpha', [
          { kind: 'builtin', relativePath: 'SKILL.md', content: 'alpha' },
        ]),
    })
    const [initialPath] = await cache.resolvePluginPaths({
      enabledSkillNames: ['alpha'],
    })
    const targetDir = initialPath.slice('/vault/'.length)
    const slashIndex = targetDir.lastIndexOf('/')
    const hash = targetDir.slice(slashIndex + 1)
    const stagingDir = `${targetDir.slice(0, slashIndex)}/.staging-${hash}`
    await adapter.rmdir(targetDir, true)
    await adapter.seedText(`${stagingDir}/keep.txt`, 'user data')

    await expect(
      cache.resolvePluginPaths({ enabledSkillNames: ['alpha'] }),
    ).rejects.toThrow(/staging directory is not owned/)
    expect(await adapter.read(`${stagingDir}/keep.txt`)).toBe('user data')
  })

  it('reads current settings on every call so base-directory changes take effect', async () => {
    const adapter = new MemoryFileSystemAdapter()
    let baseDir = 'First'
    const seenBaseDirs: Array<string | undefined> = []
    const cache = new ClaudeLocalPluginCache({
      app: createApp(adapter),
      getSettings: () => ({ yolo: { baseDir } }),
      getSkillPackageSource: async ({ settings }) => {
        seenBaseDirs.push(settings?.yolo?.baseDir)
        return source('alpha', [
          { kind: 'builtin', relativePath: 'SKILL.md', content: 'alpha' },
        ])
      },
    })

    const first = await cache.resolvePluginPaths({
      enabledSkillNames: ['alpha'],
    })
    baseDir = 'Second'
    const second = await cache.resolvePluginPaths({
      enabledSkillNames: ['alpha'],
    })

    expect(first[0]).toContain('/vault/First/.derived/claude-plugins/')
    expect(second[0]).toContain('/vault/Second/.derived/claude-plugins/')
    expect(seenBaseDirs).toEqual(['First', 'Second'])
  })

  it('refuses mobile and non-filesystem vault adapters', async () => {
    const filesystemCache = new ClaudeLocalPluginCache({
      app: createApp(new MemoryFileSystemAdapter()),
      getSettings: () => undefined,
      getSkillPackageSource: async () => null,
    })
    Platform.isDesktop = false
    await expect(
      filesystemCache.resolvePluginPaths({ enabledSkillNames: ['alpha'] }),
    ).rejects.toThrow(/only available on desktop/)

    Platform.isDesktop = true
    const nonFilesystemCache = new ClaudeLocalPluginCache({
      app: createApp({}),
      getSettings: () => undefined,
      getSkillPackageSource: async () => null,
    })
    await expect(
      nonFilesystemCache.resolvePluginPaths({ enabledSkillNames: ['alpha'] }),
    ).rejects.toThrow(/filesystem vault/)
  })
})
