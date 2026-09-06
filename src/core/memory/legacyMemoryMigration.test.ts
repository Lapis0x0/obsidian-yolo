jest.mock('obsidian')

import { App, TFile, TFolder } from 'obsidian'

import { migrateLegacyMemoryFiles } from './legacyMemoryMigration'
import { MemorySettingsLike } from './memoryStore'

type FakeVault = {
  app: App
  files: Map<string, string>
  read: (path: string) => string | undefined
  paths: () => string[]
}

const parentOf = (path: string): string => {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

const createFakeVault = (initialFiles: Record<string, string>): FakeVault => {
  const files = new Map<string, string>(Object.entries(initialFiles))
  const folders = new Set<string>()

  const registerFolders = (filePath: string) => {
    let current = parentOf(filePath)
    while (current.length > 0) {
      folders.add(current)
      current = parentOf(current)
    }
  }
  files.forEach((_content, path) => registerFolders(path))

  const buildFile = (path: string): TFile =>
    Object.assign(new TFile(), {
      path,
      name: nameOf(path),
      extension: path.includes('.')
        ? path.slice(path.lastIndexOf('.') + 1)
        : '',
    })

  const buildFolder = (path: string): TFolder => {
    const children = [
      ...[...folders]
        .filter((candidate) => parentOf(candidate) === path)
        .map((candidate) => buildFolder(candidate)),
      ...[...files.keys()]
        .filter((candidate) => parentOf(candidate) === path)
        .map((candidate) => buildFile(candidate)),
    ]
    return Object.assign(new TFolder(), {
      path,
      name: nameOf(path),
      children,
    })
  }

  const getAbstractFileByPath = (path: string) => {
    if (files.has(path)) {
      return buildFile(path)
    }
    if (folders.has(path)) {
      return buildFolder(path)
    }
    return null
  }

  const app = {
    vault: {
      getAbstractFileByPath: jest.fn(getAbstractFileByPath),
      read: jest.fn(async (file: TFile) => files.get(file.path) ?? ''),
      create: jest.fn(async (path: string, content: string) => {
        if (files.has(path)) {
          throw new Error(`File already exists: ${path}`)
        }
        files.set(path, content)
        registerFolders(path)
        return buildFile(path)
      }),
      createFolder: jest.fn(async (path: string) => {
        folders.add(path)
      }),
      modify: jest.fn(async (file: TFile, content: string) => {
        files.set(file.path, content)
      }),
    },
    fileManager: {
      trashFile: jest.fn(async (file: TFile) => {
        files.delete(file.path)
      }),
    },
  } as unknown as App

  return {
    app,
    files,
    read: (path: string) => files.get(path),
    paths: () => [...files.keys()].sort(),
  }
}

const INDEX_LINE =
  "- [Legacy memory](legacy-memory.md) — entries migrated from the old memory file; read when the user's background or preferences matter"

const FRONTMATTER = [
  '---',
  'name: legacy-memory',
  'description: Memory entries migrated from the pre-v2 single-file format; split into proper facts when you touch them',
  '---',
  '',
  '',
].join('\n')

const LEGACY_GLOBAL = [
  '# User Profile',
  '- Profile_1: Lives in Singapore',
  '',
  '# Preferences',
  '- Preference_2: Prefers concise answers',
  '- note: hand-written line, not an entry',
  '',
  '# Other Memory',
  '',
].join('\n')

const settingsWith = (
  assistants: MemorySettingsLike['assistants'],
): MemorySettingsLike => ({ assistants })

let warnSpy: jest.SpyInstance

beforeEach(() => {
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
})

describe('migrateLegacyMemoryFiles', () => {
  it('folds the global file into one fact, indexes it, and deletes the source', async () => {
    const vault = createFakeVault({ 'YOLO/memory/global.md': LEGACY_GLOBAL })

    await migrateLegacyMemoryFiles(vault.app, settingsWith([]))

    expect(vault.read('YOLO/memory/global/legacy-memory.md')).toBe(
      `${FRONTMATTER}${[
        '# User Profile',
        '- Lives in Singapore',
        '',
        '# Preferences',
        '- Prefers concise answers',
        '- note: hand-written line, not an entry',
        '',
        '# Other Memory',
        '',
      ].join('\n')}`,
    )
    expect(vault.read('YOLO/memory/global/MEMORY.md')).toBe(`${INDEX_LINE}\n`)
    expect(vault.read('YOLO/memory/global.md')).toBeUndefined()
  })

  it('lands an assistant file in the directory the injection layer reads', async () => {
    const vault = createFakeVault({
      'YOLO/memory/Writer.md': '- Profile_1: Writes in Chinese\n',
    })

    await migrateLegacyMemoryFiles(
      vault.app,
      settingsWith([{ id: 'a1', name: 'Writer' }]),
    )

    expect(vault.read('YOLO/memory/Writer/legacy-memory.md')).toBe(
      `${FRONTMATTER}- Writes in Chinese\n`,
    )
    expect(vault.read('YOLO/memory/Writer/MEMORY.md')).toBe(`${INDEX_LINE}\n`)
  })

  it('follows a configured base directory instead of hardcoding YOLO', async () => {
    const vault = createFakeVault({
      'Vault/Brain/memory/global.md': '- Memory_1: X\n',
    })

    await migrateLegacyMemoryFiles(vault.app, {
      yolo: { baseDir: 'Vault/Brain' },
      assistants: [],
    })

    expect(vault.read('Vault/Brain/memory/global/legacy-memory.md')).toBe(
      `${FRONTMATTER}- X\n`,
    )
  })

  it('keeps same-named assistants in separate directories', async () => {
    const vault = createFakeVault({
      'YOLO/memory/Writer.md': '- Profile_1: first\n',
      'YOLO/memory/Writer (2).md': '- Profile_1: second\n',
    })

    await migrateLegacyMemoryFiles(
      vault.app,
      settingsWith([
        { id: 'a1', name: 'Writer' },
        { id: 'a2', name: 'Writer' },
      ]),
    )

    expect(vault.read('YOLO/memory/Writer/legacy-memory.md')).toBe(
      `${FRONTMATTER}- first\n`,
    )
    expect(vault.read('YOLO/memory/Writer (2)/legacy-memory.md')).toBe(
      `${FRONTMATTER}- second\n`,
    )
  })

  it('migrates an assistant named global as global memory and warns', async () => {
    const vault = createFakeVault({
      'YOLO/memory/global.md': '- Profile_1: shared file\n',
    })

    await migrateLegacyMemoryFiles(
      vault.app,
      settingsWith([{ id: 'a1', name: 'global' }]),
    )

    expect(vault.read('YOLO/memory/global/legacy-memory.md')).toBe(
      `${FRONTMATTER}- shared file\n`,
    )
    expect(
      vault.read('YOLO/memory/global (assistant)/legacy-memory.md'),
    ).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('shares the legacy global memory file'),
    )
  })

  it('keeps memory of a deleted assistant, keyed by the old file name', async () => {
    const vault = createFakeVault({
      'YOLO/memory/Ghost.md': '- Profile_1: still worth keeping\n',
    })

    await migrateLegacyMemoryFiles(vault.app, settingsWith([]))

    expect(vault.read('YOLO/memory/Ghost/legacy-memory.md')).toBe(
      `${FRONTMATTER}- still worth keeping\n`,
    )
    expect(vault.read('YOLO/memory/Ghost.md')).toBeUndefined()
  })

  it('appends to an existing index without duplicating the line', async () => {
    const vault = createFakeVault({
      'YOLO/memory/global.md': '- Profile_1: X\n',
      'YOLO/memory/global/MEMORY.md': '- [Travel](travel.md) — trips',
    })

    await migrateLegacyMemoryFiles(vault.app, settingsWith([]))

    expect(vault.read('YOLO/memory/global/MEMORY.md')).toBe(
      `- [Travel](travel.md) — trips\n${INDEX_LINE}\n`,
    )
  })

  it('is a no-op on a second run', async () => {
    const vault = createFakeVault({
      'YOLO/memory/global.md': LEGACY_GLOBAL,
      'YOLO/memory/Writer.md': '- Profile_1: Writes in Chinese\n',
    })
    const settings = settingsWith([{ id: 'a1', name: 'Writer' }])

    await migrateLegacyMemoryFiles(vault.app, settings)
    const afterFirst = vault.paths().map((path) => [path, vault.read(path)])

    await migrateLegacyMemoryFiles(vault.app, settings)

    expect(vault.paths().map((path) => [path, vault.read(path)])).toEqual(
      afterFirst,
    )
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('skips a scope whose legacy fact already exists and leaves the source alone', async () => {
    const vault = createFakeVault({
      'YOLO/memory/global.md': '- Profile_1: restored by hand\n',
      'YOLO/memory/global/legacy-memory.md': 'already migrated\n',
      'YOLO/memory/global/MEMORY.md': `${INDEX_LINE}\n`,
    })

    await migrateLegacyMemoryFiles(vault.app, settingsWith([]))

    expect(vault.read('YOLO/memory/global/legacy-memory.md')).toBe(
      'already migrated\n',
    )
    expect(vault.read('YOLO/memory/global.md')).toBe(
      '- Profile_1: restored by hand\n',
    )
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('already exists'),
    )
  })

  it('migrates an empty legacy file rather than leaving it behind', async () => {
    const vault = createFakeVault({ 'YOLO/memory/global.md': '' })

    await migrateLegacyMemoryFiles(vault.app, settingsWith([]))

    expect(vault.read('YOLO/memory/global/legacy-memory.md')).toBe(
      `${FRONTMATTER}\n`,
    )
    expect(vault.read('YOLO/memory/global.md')).toBeUndefined()
  })

  it('does nothing when there is no memory directory', async () => {
    const vault = createFakeVault({ 'YOLO/other.md': 'x' })

    await migrateLegacyMemoryFiles(vault.app, settingsWith([]))

    expect(vault.paths()).toEqual(['YOLO/other.md'])
  })

  it('ignores v2 files nested in scope directories', async () => {
    const vault = createFakeVault({
      'YOLO/memory/global/MEMORY.md': '- [Travel](travel.md) — trips\n',
      'YOLO/memory/global/travel.md': 'body\n',
    })

    await migrateLegacyMemoryFiles(vault.app, settingsWith([]))

    expect(vault.paths()).toEqual([
      'YOLO/memory/global/MEMORY.md',
      'YOLO/memory/global/travel.md',
    ])
  })
})
