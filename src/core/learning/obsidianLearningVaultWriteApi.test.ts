import { TFile } from 'obsidian'
import type { App } from 'obsidian'

import { createObsidianLearningVaultWriteApi } from './obsidianLearningVaultWriteApi'

function createVault(initial: Record<string, string> = {}) {
  const contents = new Map(Object.entries(initial))
  const entries = new Map<string, TFile>()
  for (const path of contents.keys()) entries.set(path, createFile(path))
  const create = jest.fn(async (path: string, content: string) => {
    const file = createFile(path)
    entries.set(path, file)
    contents.set(path, content)
    return file
  })
  const modify = jest.fn(async (file: TFile, content: string) => {
    contents.set(file.path, content)
  })
  const process = jest.fn(
    async (file: TFile, update: (data: string) => string) => {
      const next = update(contents.get(file.path) ?? '')
      await modify(file, next)
      return next
    },
  )
  const createBinary = jest.fn(async (path: string) => createFile(path))
  const createFolder = jest.fn(async () => undefined)
  const mkdir = jest.fn(async () => undefined)
  const list = jest.fn(async () => ({
    files: ['p/one.md', 'p/two.pdf'],
    folders: ['p/nested'],
  }))
  const rename = jest.fn(async () => undefined)
  const rmdir = jest.fn(async () => undefined)
  const remove = jest.fn(async () => undefined)
  const exists = jest.fn(async (path: string) => entries.has(path))
  const stat = jest.fn(async (path: string) =>
    entries.has(path) ? { type: 'file' as const } : null,
  )
  const deletePath = jest.fn(async (entry: TFile) => {
    entries.delete(entry.path)
    contents.delete(entry.path)
  })

  const app = {
    vault: {
      getAbstractFileByPath: jest.fn(
        (path: string) => entries.get(path) ?? null,
      ),
      read: jest.fn(async (file: TFile) => contents.get(file.path) ?? ''),
      create,
      createBinary,
      createFolder,
      modify,
      process,
      delete: deletePath,
      adapter: { mkdir, list, rename, rmdir, remove, exists, stat },
    },
  } as unknown as App
  return {
    app,
    api: createObsidianLearningVaultWriteApi(app),
    contents,
    entries,
    create,
    modify,
    process,
    createBinary,
    createFolder,
    mkdir,
    list,
    rename,
    rmdir,
    exists,
    deletePath,
  }
}

function createFile(path: string): TFile {
  const file = new TFile()
  file.path = path
  file.name = path.split('/').at(-1) ?? ''
  file.stat = { ctime: 100, mtime: 123, size: 0 }
  return file
}

describe('Obsidian Learning vault write adapter', () => {
  it('provides normalized path operations through Vault and DataAdapter', async () => {
    const { api, createBinary, createFolder, mkdir, rename, rmdir } =
      createVault()
    const content = new ArrayBuffer(2)

    await api.ensureFolder('/p//nested/')
    await api.createFolder('/p//exclusive/')
    await expect(api.listChildNames('/p/')).resolves.toEqual([
      'one.md',
      'two.pdf',
      'nested',
    ])
    await expect(api.listChildFilePaths('/p/')).resolves.toEqual([
      'p/one.md',
      'p/two.pdf',
    ])
    await api.createBinary('/p//binary.pdf/', content)
    await api.renamePath('/p//one.md', '/p//renamed.md/')
    await api.removeTree('/p//nested/')

    expect(mkdir).toHaveBeenCalledWith('p/nested')
    expect(createFolder).toHaveBeenCalledWith('p/exclusive')
    expect(createBinary).toHaveBeenCalledWith('p/binary.pdf', content)
    expect(rename).toHaveBeenCalledWith('p/one.md', 'p/renamed.md')
    expect(rmdir).toHaveBeenCalledWith('p/nested', true)
  })

  it('removes folders only when they are empty and never recursively', async () => {
    const { api, exists, list, rmdir } = createVault()
    exists.mockResolvedValue(true)
    list.mockResolvedValueOnce({ files: [], folders: [] })

    await api.removeEmptyFolder('/p//empty/')
    expect(rmdir).toHaveBeenCalledWith('p/empty', false)

    list.mockResolvedValueOnce({
      files: ['p/nonempty/foreign.md'],
      folders: [],
    })
    await api.removeEmptyFolder('/p//nonempty/')
    expect(rmdir).not.toHaveBeenCalledWith('p/nonempty', expect.anything())
  })

  it('creates and writes text by path with the resulting mtime', async () => {
    const { api, contents } = createVault({ 'p/existing.md': 'before' })

    await expect(api.createText('/p//new.md/', 'new')).resolves.toEqual({
      path: 'p/new.md',
      mtime: 123,
    })
    await expect(api.writeText('/p//existing.md/', 'after')).resolves.toEqual({
      path: 'p/existing.md',
      mtime: 123,
    })

    expect(contents.get('p/new.md')).toBe('new')
    expect(contents.get('p/existing.md')).toBe('after')
  })

  it('permanently removes only the exact requested path', async () => {
    const { api, contents, deletePath } = createVault({
      'p/owned.md': 'owned',
      'p/other.md': 'other',
    })

    await api.removeExactPath('/p//owned.md/')

    expect(deletePath).toHaveBeenCalledWith(expect.any(TFile), true)
    expect(contents.has('p/owned.md')).toBe(false)
    expect(contents.get('p/other.md')).toBe('other')
  })

  it('creates only when absent and normalizes paths inside the adapter', async () => {
    const { api, contents, create } = createVault()

    const created = await api.createTextIfAbsent('/p//cards.md/', 'first')

    expect(created).toMatchObject({ path: 'p/cards.md', content: 'first' })
    expect(contents.get('p/cards.md')).toBe('first')
    await expect(
      api.createTextIfAbsent('p/cards.md', 'second'),
    ).resolves.toBeNull()
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('updates only the same file identity with unchanged full content', async () => {
    const { api, contents, entries, modify } = createVault({
      'p/cards.md': 'before',
    })
    const snapshot = await api.readTextSnapshot('p/cards.md')
    expect(snapshot).not.toBeNull()
    if (!snapshot) return

    contents.set('p/cards.md', 'external')
    await expect(
      api.replaceTextIfUnchanged(snapshot, 'after'),
    ).resolves.toBeNull()
    contents.set('p/cards.md', 'before')
    entries.set('p/cards.md', createFile('p/cards.md'))
    await expect(
      api.replaceTextIfUnchanged(snapshot, 'after'),
    ).resolves.toBeNull()

    expect(modify).not.toHaveBeenCalled()
  })

  it('shares path serialization across API instances so only one CAS wins', async () => {
    const { app, api, contents, process } = createVault({
      'p/cards.md': 'before',
    })
    const otherApi = createObsidianLearningVaultWriteApi(app)
    const firstSnapshot = await api.readTextSnapshot('p/cards.md')
    const secondSnapshot = await otherApi.readTextSnapshot('p/cards.md')
    expect(firstSnapshot).not.toBeNull()
    expect(secondSnapshot).not.toBeNull()
    if (!firstSnapshot || !secondSnapshot) return

    let releaseFirst: () => void = () => undefined
    const firstPaused = new Promise<void>((resolvePaused) => {
      process.mockImplementationOnce(
        async (file: TFile, update: (data: string) => string) => {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve
            resolvePaused()
          })
          const next = update(contents.get(file.path) ?? '')
          contents.set(file.path, next)
          return next
        },
      )
    })

    const first = api.replaceTextIfUnchanged(firstSnapshot, 'first')
    await firstPaused
    const second = otherApi.replaceTextIfUnchanged(secondSnapshot, 'second')
    releaseFirst()

    const results = await Promise.all([first, second])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(contents.get('p/cards.md')).toBe('first')
  })

  it('preserves an external edit observed inside process without touching it', async () => {
    const { api, contents, modify, process } = createVault({
      'p/cards.md': 'before',
    })
    const expected = await api.readTextSnapshot('p/cards.md')
    expect(expected).not.toBeNull()
    if (!expected) return
    process.mockImplementationOnce(
      async (file: TFile, update: (data: string) => string) => {
        contents.set(file.path, 'external')
        return update('external')
      },
    )

    await expect(
      api.replaceTextIfUnchanged(expected, 'after'),
    ).resolves.toBeNull()
    expect(contents.get('p/cards.md')).toBe('external')
    expect(modify).not.toHaveBeenCalled()
  })

  it('reverts only snapshots in its creation receipt lineage', async () => {
    const { api, contents } = createVault()
    const created = await api.createTextIfAbsent('p/cards.md', 'created')
    expect(created).not.toBeNull()
    if (!created) return

    contents.set('p/cards.md', 'external')
    await expect(
      api.revertOwnedCreatedTextIfUnchanged(created, created, 'empty'),
    ).resolves.toBeNull()
    contents.set('p/cards.md', 'created')
    const ordinarySnapshot = await api.readTextSnapshot('p/cards.md')
    expect(ordinarySnapshot).not.toBeNull()
    if (!ordinarySnapshot) return
    await expect(
      api.revertOwnedCreatedTextIfUnchanged(created, ordinarySnapshot, 'empty'),
    ).resolves.toBeNull()
    await expect(
      api.revertOwnedCreatedTextIfUnchanged(created, created, 'empty'),
    ).resolves.toMatchObject({ content: 'empty' })

    expect(contents.get('p/cards.md')).toBe('empty')
  })
})
