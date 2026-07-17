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

  const app = {
    vault: {
      getAbstractFileByPath: jest.fn(
        (path: string) => entries.get(path) ?? null,
      ),
      read: jest.fn(async (file: TFile) => contents.get(file.path) ?? ''),
      create,
      modify,
      delete: deleteFile,
    },
  } as unknown as App
  return {
    api: createObsidianLearningVaultWriteApi(app),
    contents,
    entries,
    create,
    modify,
    deleteFile,
  }
}

function createFile(path: string): TFile {
  const file = new TFile()
  file.path = path
  file.name = path.split('/').at(-1) ?? ''
  return file
}

describe('Obsidian Learning vault write adapter', () => {
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
    await expect(api.deleteCreatedTextIfUnchanged(created)).resolves.toBe(true)

    expect(deleteFile).toHaveBeenCalledTimes(1)
    expect(contents.has('p/cards.md')).toBe(false)
  })
})
