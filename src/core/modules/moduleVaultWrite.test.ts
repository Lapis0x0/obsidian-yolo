jest.mock('obsidian', () => {
  class TFile {}
  class TFolder {}
  return {
    App: class {},
    TFile,
    TFolder,
    normalizePath: (path: string) => path,
  }
})

import { type App, TFile, TFolder } from 'obsidian'

import { ModuleLifecycleScope } from './lifecycleScope'
import { ObsidianModuleVaultCapabilityProvider } from './moduleVault'

const createFile = (path: string, mtime = 1): TFile =>
  Object.assign(new TFile(), {
    path,
    name: path.split('/').at(-1) ?? '',
    stat: { ctime: mtime, mtime, size: 0 },
  })

const createFolder = (path: string): TFolder =>
  Object.assign(new TFolder(), {
    path,
    name: path.split('/').at(-1) ?? '',
    children: [] as Array<TFile | TFolder>,
  })

function createWritableApp(initial: Record<string, string> = {}) {
  const entries = new Map<string, TFile | TFolder>()
  const text = new Map<string, string>()
  const binary = new Map<string, ArrayBuffer>()
  let clock = 10

  const addFolder = (path: string) => {
    const folder = createFolder(path)
    entries.set(path, folder)
    return folder
  }
  const addFile = (path: string, content: string) => {
    clock += 1
    const file = createFile(path, clock)
    entries.set(path, file)
    text.set(path, content)
    return file
  }
  addFolder('projects')
  for (const [path, content] of Object.entries(initial)) addFile(path, content)

  const processFile = async (
    file: TFile,
    update: (current: string) => string,
  ) => {
    const current = text.get(file.path) ?? ''
    const next = update(current)
    text.set(file.path, next)
    file.stat.mtime = ++clock
  }
  const deleteEntry = async (entry: TFile | TFolder) => {
    const prefix = `${entry.path}/`
    for (const path of [...entries.keys()]) {
      if (path === entry.path || path.startsWith(prefix)) {
        entries.delete(path)
        text.delete(path)
        binary.delete(path)
      }
    }
  }
  const vault = {
    getAbstractFileByPath: jest.fn((path: string) =>
      path.split('/').some((segment) => segment.startsWith('.'))
        ? null
        : (entries.get(path) ?? null),
    ),
    getMarkdownFiles: jest.fn(() => []),
    cachedRead: jest.fn(async (file: TFile) => text.get(file.path) ?? ''),
    read: jest.fn(async (file: TFile) => text.get(file.path) ?? ''),
    readBinary: jest.fn(
      async (file: TFile) => binary.get(file.path) ?? new ArrayBuffer(0),
    ),
    createFolder: jest.fn(async (path: string) => {
      if (entries.has(path)) throw new Error('already exists')
      return addFolder(path)
    }),
    create: jest.fn(async (path: string, content: string) => {
      if (entries.has(path)) throw new Error('already exists')
      return addFile(path, content)
    }),
    createBinary: jest.fn(async (path: string, content: ArrayBuffer) => {
      if (entries.has(path)) throw new Error('already exists')
      const file = addFile(path, '')
      binary.set(path, content)
      return file
    }),
    modify: jest.fn(async (file: TFile, content: string) => {
      text.set(file.path, content)
      file.stat.mtime = ++clock
    }),
    process: jest.fn(processFile),
    delete: jest.fn(deleteEntry),
    adapter: {
      exists: jest.fn(async (path: string) => entries.has(path)),
      stat: jest.fn(async (path: string) => {
        const entry = entries.get(path)
        if (!entry) return null
        return entry instanceof TFile
          ? { type: 'file', ...entry.stat }
          : { type: 'folder', ctime: 0, mtime: 0, size: 0 }
      }),
      list: jest.fn(async (path: string) => {
        const prefix = `${path}/`
        const direct = [...entries.values()].filter(
          (entry) =>
            entry.path.startsWith(prefix) &&
            !entry.path.slice(prefix.length).includes('/'),
        )
        return {
          files: direct
            .filter((entry) => entry instanceof TFile)
            .map((entry) => entry.path),
          folders: direct
            .filter((entry) => entry instanceof TFolder)
            .map((entry) => entry.path),
        }
      }),
      read: jest.fn(async (path: string) => text.get(path) ?? ''),
      readBinary: jest.fn(
        async (path: string) => binary.get(path) ?? new ArrayBuffer(0),
      ),
      write: jest.fn(async (path: string, content: string) => {
        if (!entries.has(path)) addFile(path, content)
        else text.set(path, content)
      }),
      writeBinary: jest.fn(async (path: string, content: ArrayBuffer) => {
        if (!entries.has(path)) addFile(path, '')
        binary.set(path, content)
      }),
      mkdir: jest.fn(async (path: string) => void addFolder(path)),
      remove: jest.fn(async (path: string) => {
        const entry = entries.get(path)
        if (entry) await deleteEntry(entry)
      }),
      rmdir: jest.fn(async (path: string) => {
        const entry = entries.get(path)
        if (entry) await deleteEntry(entry)
      }),
    },
    on: jest.fn(() => ({})),
    offref: jest.fn(),
  }
  const fileManager = {
    renameFile: jest.fn(async (entry: TFile | TFolder, destination: string) => {
      const source = entry.path
      entries.delete(source)
      const content = text.get(source)
      const bytes = binary.get(source)
      text.delete(source)
      binary.delete(source)
      entry.path = destination
      entry.name = destination.split('/').at(-1) ?? ''
      entries.set(destination, entry)
      if (content !== undefined) text.set(destination, content)
      if (bytes !== undefined) binary.set(destination, bytes)
    }),
    trashFile: jest.fn(deleteEntry),
  }
  return {
    app: { vault, fileManager } as unknown as App,
    addFile,
    addFolder,
    binary,
    entries,
    fileManager,
    processFile,
    text,
    vault,
  }
}

describe('module vault writes', () => {
  it('reads and writes hidden Vault sidecars outside the Obsidian index', async () => {
    const { app, addFolder, entries, text, vault } = createWritableApp()
    addFolder('YOLO')
    const lifecycle = new ModuleLifecycleScope()
    const api = new ObsidianModuleVaultCapabilityProvider(app).create(
      'learning',
      lifecycle,
    ).api
    const root = 'YOLO/.yolo_json_db/learning-srs'
    const path = `${root}/project.json`

    await api.ensureFolder(root)
    const created = await api.createTextIfAbsent(path, 'v1')
    expect(created).toEqual({ path, content: 'v1' })
    expect(await api.readText(path)).toBe('v1')
    expect(await api.stat(root)).toMatchObject({ kind: 'folder', path: root })
    expect(await api.list(root)).toEqual([
      expect.objectContaining({ kind: 'file', path }),
    ])

    const updated = await api.replaceTextIfUnchanged(created!, 'v2')
    expect(updated).toEqual({ path, content: 'v2' })
    expect(text.get(path)).toBe('v2')
    expect(vault.createFolder).not.toHaveBeenCalledWith(
      expect.stringContaining('.yolo_json_db'),
    )
    expect(entries.has(path)).toBe(true)
    lifecycle.dispose()
  })

  it('supports managed folders, files, rename, trash, and safe removal', async () => {
    const { app, binary, entries, fileManager, text } = createWritableApp()
    const lifecycle = new ModuleLifecycleScope()
    const api = new ObsidianModuleVaultCapabilityProvider(app).create(
      'writer',
      lifecycle,
    ).api

    await api.ensureFolder('projects/generated/nested')
    expect(entries.get('projects/generated/nested')).toBeInstanceOf(TFolder)
    await api.createFolder('projects/empty')
    const created = await api.createText('projects/generated/note.md', 'one')
    expect(created).toMatchObject({ path: 'projects/generated/note.md' })
    expect(Object.isFrozen(created)).toBe(true)
    await api.writeText('projects/generated/note.md', 'two')
    expect(text.get('projects/generated/note.md')).toBe('two')

    const source = Uint8Array.from([1, 2, 3]).buffer
    const creatingBinary = api.createBinary(
      'projects/generated/image.bin',
      source,
    )
    new Uint8Array(source)[0] = 9
    await creatingBinary
    expect([
      ...new Uint8Array(binary.get('projects/generated/image.bin')!),
    ]).toEqual([1, 2, 3])

    await api.renamePath(
      'projects/generated/note.md',
      'projects/generated/renamed.md',
    )
    expect(text.get('projects/generated/renamed.md')).toBe('two')
    expect(fileManager.renameFile).toHaveBeenCalledTimes(1)
    await expect(api.trashPath('projects/generated/renamed.md')).resolves.toBe(
      true,
    )
    await expect(api.trashPath('projects/generated/missing.md')).resolves.toBe(
      false,
    )
    await expect(
      api.renamePath('projects/generated', 'projects/moved'),
    ).rejects.toThrow('file not found')
    await api.trashPath('projects/generated/image.bin')
    expect(entries.has('projects/generated/image.bin')).toBe(false)
    await api.trashPath('projects/empty')
    expect(entries.has('projects/empty')).toBe(false)
    await api.trashPath('projects/generated')
    expect(
      [...entries.keys()].some((path) => path.startsWith('projects/generated')),
    ).toBe(false)
    await expect(api.createText('missing/file.md', 'x')).rejects.toThrow(
      'parent folder not found',
    )
    lifecycle.dispose()
  })

  it('rejects forged, stale, cross-module, and delete-recreate snapshots', async () => {
    const { app, addFile, entries, text } = createWritableApp({
      'projects/cards.md': 'v1',
    })
    const firstLifecycle = new ModuleLifecycleScope()
    const secondLifecycle = new ModuleLifecycleScope()
    const first = new ObsidianModuleVaultCapabilityProvider(app).create(
      'first',
      firstLifecycle,
    ).api
    const second = new ObsidianModuleVaultCapabilityProvider(app).create(
      'second',
      secondLifecycle,
    ).api

    const initial = await first.readTextSnapshot('projects/cards.md')
    expect(initial).toEqual({ path: 'projects/cards.md', content: 'v1' })
    expect(Object.isFrozen(initial)).toBe(true)
    await expect(
      first.replaceTextIfUnchanged(
        { path: 'projects/cards.md', content: 'v1' },
        'forged',
      ),
    ).resolves.toBeNull()
    await expect(
      second.replaceTextIfUnchanged(initial!, 'cross-module'),
    ).resolves.toBeNull()

    const updated = await first.replaceTextIfUnchanged(initial!, 'v2')
    expect(updated?.content).toBe('v2')
    await expect(
      first.replaceTextIfUnchanged(initial!, 'stale'),
    ).resolves.toBeNull()
    expect(text.get('projects/cards.md')).toBe('v2')

    const beforeRecreate = await first.readTextSnapshot('projects/cards.md')
    entries.delete('projects/cards.md')
    text.delete('projects/cards.md')
    addFile('projects/cards.md', 'replacement')
    await expect(
      first.replaceTextIfUnchanged(beforeRecreate!, 'unsafe'),
    ).resolves.toBeNull()
    expect(text.get('projects/cards.md')).toBe('replacement')
    firstLifecycle.dispose()
    secondLifecycle.dispose()
  })

  it('reverts only a still-owned created text payload', async () => {
    const { app, text } = createWritableApp()
    const lifecycle = new ModuleLifecycleScope()
    const api = new ObsidianModuleVaultCapabilityProvider(app).create(
      'writer',
      lifecycle,
    ).api

    const created = await api.createTextIfAbsent('projects/cards.md', 'v1')
    expect(created).not.toBeNull()
    await expect(
      api.createTextIfAbsent('projects/cards.md', 'duplicate'),
    ).resolves.toBeNull()
    const updated = await api.replaceTextIfUnchanged(created!, 'v2')
    const latest = await api.replaceTextIfUnchanged(updated!, 'v3')
    const reverted = await api.revertOwnedCreatedTextIfUnchanged(
      created!,
      latest!,
      '',
    )
    expect(reverted?.content).toBe('')
    expect(text.get('projects/cards.md')).toBe('')
    await api.writeText('projects/cards.md', 'v3')
    await expect(
      api.revertOwnedCreatedTextIfUnchanged(created!, latest!, 'unsafe'),
    ).resolves.toBeNull()
    expect(text.get('projects/cards.md')).toBe('v3')

    const ordinary = await api.readTextSnapshot('projects/cards.md')
    await expect(
      api.revertOwnedCreatedTextIfUnchanged(ordinary!, ordinary!, 'unsafe'),
    ).resolves.toBeNull()
    lifecycle.dispose()
  })

  it('serializes CAS across module capabilities for the same App and path', async () => {
    const { app, processFile, text, vault } = createWritableApp({
      'projects/cards.md': 'v1',
    })
    const firstLifecycle = new ModuleLifecycleScope()
    const secondLifecycle = new ModuleLifecycleScope()
    const first = new ObsidianModuleVaultCapabilityProvider(app).create(
      'first',
      firstLifecycle,
    ).api
    const second = new ObsidianModuleVaultCapabilityProvider(app).create(
      'second',
      secondLifecycle,
    ).api
    const firstSnapshot = await first.readTextSnapshot('projects/cards.md')
    const secondSnapshot = await second.readTextSnapshot('projects/cards.md')
    let releaseFirst!: () => void
    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    vault.process.mockImplementationOnce(async (file, update) => {
      await blocked
      await processFile(file, update)
    })

    const firstWrite = first.replaceTextIfUnchanged(firstSnapshot!, 'first')
    const secondWrite = second.replaceTextIfUnchanged(secondSnapshot!, 'second')
    await Promise.resolve()
    expect(vault.process).toHaveBeenCalledTimes(1)
    releaseFirst()

    await expect(firstWrite).resolves.toMatchObject({ content: 'first' })
    await expect(secondWrite).resolves.toBeNull()
    expect(text.get('projects/cards.md')).toBe('first')
    expect(vault.process).toHaveBeenCalledTimes(2)
    firstLifecycle.dispose()
    secondLifecycle.dispose()
  })

  it('serializes parent trash behind a descendant write', async () => {
    const { app, addFolder, entries, text, fileManager, vault } =
      createWritableApp({ 'projects/generated/card.md': 'v1' })
    addFolder('projects/generated')
    const lifecycle = new ModuleLifecycleScope()
    const api = new ObsidianModuleVaultCapabilityProvider(app).create(
      'writer',
      lifecycle,
    ).api
    let releaseModify!: () => void
    const blocked = new Promise<void>((resolve) => {
      releaseModify = resolve
    })
    vault.modify.mockImplementationOnce(async (file, content) => {
      await blocked
      text.set(file.path, content)
    })

    const writing = api.writeText('projects/generated/card.md', 'v2')
    const trashing = api.trashPath('projects/generated')
    await Promise.resolve()
    await Promise.resolve()
    expect(vault.modify).toHaveBeenCalledTimes(1)
    expect(fileManager.trashFile).not.toHaveBeenCalled()

    releaseModify()
    await writing
    await trashing
    expect(entries.has('projects/generated')).toBe(false)
    expect(entries.has('projects/generated/card.md')).toBe(false)
    lifecycle.dispose()
  })

  it('rechecks creation ownership after a queued revert acquires the lock', async () => {
    const { app, processFile, text, vault } = createWritableApp()
    const lifecycle = new ModuleLifecycleScope()
    const api = new ObsidianModuleVaultCapabilityProvider(app).create(
      'writer',
      lifecycle,
    ).api
    const created = await api.createTextIfAbsent('projects/cards.md', 'v1')
    const expected = await api.replaceTextIfUnchanged(created!, 'v2')
    let releaseFirst!: () => void
    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    vault.process.mockImplementationOnce(async (file, update) => {
      await blocked
      await processFile(file, update)
    })

    const firstRevert = api.revertOwnedCreatedTextIfUnchanged(
      created!,
      expected!,
      '',
    )
    const interveningWrite = api.writeText('projects/cards.md', 'v2')
    const replay = api.revertOwnedCreatedTextIfUnchanged(
      created!,
      expected!,
      'unsafe',
    )
    await Promise.resolve()
    expect(vault.process).toHaveBeenCalledTimes(2)
    releaseFirst()

    await expect(firstRevert).resolves.toMatchObject({ content: '' })
    await interveningWrite
    await expect(replay).resolves.toBeNull()
    expect(text.get('projects/cards.md')).toBe('v2')
    lifecycle.dispose()
  })

  it('rejects queued writes after module disposal', async () => {
    const { app, processFile, text, vault } = createWritableApp({
      'projects/cards.md': 'v1',
    })
    const lifecycle = new ModuleLifecycleScope()
    const api = new ObsidianModuleVaultCapabilityProvider(app).create(
      'writer',
      lifecycle,
    ).api
    const snapshot = await api.readTextSnapshot('projects/cards.md')
    let releaseProcess!: () => void
    const blocked = new Promise<void>((resolve) => {
      releaseProcess = resolve
    })
    vault.process.mockImplementationOnce(async (file, update) => {
      await blocked
      await processFile(file, update)
    })
    const activeWrite = api.replaceTextIfUnchanged(snapshot!, 'active')
    const queuedWrite = api.writeText('projects/cards.md', 'queued')
    await Promise.resolve()

    lifecycle.dispose()
    releaseProcess()

    await expect(activeWrite).resolves.toMatchObject({ content: 'active' })
    await expect(queuedWrite).rejects.toThrow('vault is not active')
    expect(text.get('projects/cards.md')).toBe('active')
  })
})
