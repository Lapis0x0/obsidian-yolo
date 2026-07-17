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
  const deleteFile = jest.fn(async (file: TFile) => {
    entries.delete(file.path)
    contents.delete(file.path)
  })
  const createBinary = jest.fn(async (path: string) => createFile(path))
  const mkdir = jest.fn(async () => undefined)
  const list = jest.fn(async () => ({
    files: ['p/one.md', 'p/two.pdf'],
    folders: ['p/nested'],
  }))
  const rename = jest.fn(async () => undefined)
  const rmdir = jest.fn(async () => undefined)

  const app = {
    vault: {
      getAbstractFileByPath: jest.fn(
        (path: string) => entries.get(path) ?? null,
      ),
      read: jest.fn(async (file: TFile) => contents.get(file.path) ?? ''),
      create,
      createBinary,
      modify,
      delete: deleteFile,
      adapter: { mkdir, list, rename, rmdir },
    },
  } as unknown as App
  return {
    api: createObsidianLearningVaultWriteApi(app),
    contents,
    entries,
    create,
    modify,
    deleteFile,
    createBinary,
    mkdir,
    list,
    rename,
    rmdir,
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
    const { api, createBinary, mkdir, rename, rmdir } = createVault()
    const content = new ArrayBuffer(2)

    await api.ensureFolder('/p//nested/')
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
    expect(createBinary).toHaveBeenCalledWith('p/binary.pdf', content)
    expect(rename).toHaveBeenCalledWith('p/one.md', 'p/renamed.md')
    expect(rmdir).toHaveBeenCalledWith('p/nested', true)
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

  it('rollback-deletes only its creation receipt while content still matches', async () => {
    const { api, contents, deleteFile } = createVault()
    const created = await api.createTextIfAbsent('p/cards.md', 'created')
    expect(created).not.toBeNull()
    if (!created) return

    contents.set('p/cards.md', 'external')
    await expect(api.deleteCreatedTextIfUnchanged(created)).resolves.toBe(false)
    contents.set('p/cards.md', 'created')
    const ordinarySnapshot = await api.readTextSnapshot('p/cards.md')
    expect(ordinarySnapshot).not.toBeNull()
    if (!ordinarySnapshot) return
    await expect(
      api.deleteCreatedTextIfUnchanged(ordinarySnapshot),
    ).resolves.toBe(false)
    await expect(
      api.deleteOwnedTextIfUnchanged(created, ordinarySnapshot),
    ).resolves.toBe(true)

    expect(deleteFile).toHaveBeenCalledTimes(1)
    expect(contents.has('p/cards.md')).toBe(false)
  })
})
