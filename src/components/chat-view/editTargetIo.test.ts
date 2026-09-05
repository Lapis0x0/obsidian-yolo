jest.mock('obsidian')

/* eslint-disable import/no-nodejs-modules -- the outside-vault branch is real node fs, so a mocked one would test nothing */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
/* eslint-enable import/no-nodejs-modules */

import { App, TFile } from 'obsidian'

import type { EditReviewSnapshot } from '../../database/edit-review/editReviewSnapshotStore'

import {
  isOutsideVaultEditPath,
  openEditTarget,
  usableSnapshotPair,
} from './editTargetIo'

const createVaultApp = (files: Record<string, string>) => {
  const contents = new Map(Object.entries(files))
  const folders = new Set<string>()
  const trashed: string[] = []

  const resolve = (path: string) => {
    if (!contents.has(path)) return null
    const file = new TFile()
    file.path = path
    return file
  }

  const app = {
    vault: {
      getAbstractFileByPath: (path: string) =>
        resolve(path) ?? (folders.has(path) ? { path } : null),
      read: async (file: TFile) => contents.get(file.path) ?? '',
      modify: async (file: TFile, content: string) => {
        contents.set(file.path, content)
      },
      create: async (path: string, content: string) => {
        contents.set(path, content)
      },
      createFolder: async (path: string) => {
        folders.add(path)
      },
    },
    fileManager: {
      trashFile: async (file: TFile) => {
        contents.delete(file.path)
        trashed.push(file.path)
      },
    },
  } as unknown as App

  return { app, contents, folders, trashed }
}

const snapshot = (
  overrides: Partial<EditReviewSnapshot> = {},
): EditReviewSnapshot => ({
  conversationId: 'conv-1',
  roundId: 'round-1',
  filePath: 'note.md',
  beforeContent: 'before',
  afterContent: 'after',
  beforeExists: true,
  afterExists: true,
  addedLines: 1,
  removedLines: 1,
  lineStatsAvailable: true,
  contentAvailable: true,
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
})

describe('isOutsideVaultEditPath', () => {
  it('tells the two edit-summary path shapes apart', () => {
    expect(isOutsideVaultEditPath('notes/a.md')).toBe(false)
    expect(isOutsideVaultEditPath('/Users/me/out.txt')).toBe(true)
    expect(isOutsideVaultEditPath('C:\\work\\out.txt')).toBe(true)
  })
})

describe('openEditTarget (vault-relative path)', () => {
  it('reads through the vault and reports a missing file as null', async () => {
    const { app } = createVaultApp({ 'note.md': 'hello' })

    await expect((await openEditTarget(app, 'note.md')).read()).resolves.toBe(
      'hello',
    )
    await expect(
      (await openEditTarget(app, 'gone.md')).read(),
    ).resolves.toBeNull()
  })

  it('creates the missing parent folders when restoring a deleted file', async () => {
    const { app, contents, folders } = createVaultApp({})

    await (await openEditTarget(app, 'a/b/note.md')).write('restored')

    expect(contents.get('a/b/note.md')).toBe('restored')
    expect([...folders]).toEqual(['a', 'a/b'])
  })

  it('trashes rather than hard-deletes', async () => {
    const { app, trashed } = createVaultApp({ 'note.md': 'hello' })

    await (await openEditTarget(app, 'note.md')).trash()

    expect(trashed).toEqual(['note.md'])
  })
})

describe('openEditTarget (absolute path)', () => {
  let root: string
  const { app } = createVaultApp({})

  beforeEach(async () => {
    root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'yolo-edit-target-'))
  })

  it('reads through node fs and reports a missing file as null', async () => {
    const target = nodePath.join(root, 'out.txt')
    await fs.writeFile(target, 'hello')

    await expect((await openEditTarget(app, target)).read()).resolves.toBe(
      'hello',
    )
    await expect(
      (await openEditTarget(app, nodePath.join(root, 'gone.txt'))).read(),
    ).resolves.toBeNull()
  })

  it('writes an existing file and creates missing parent directories', async () => {
    const existing = nodePath.join(root, 'out.txt')
    await fs.writeFile(existing, 'old')
    await (await openEditTarget(app, existing)).write('new')
    await expect(fs.readFile(existing, 'utf-8')).resolves.toBe('new')

    const nested = nodePath.join(root, 'a', 'b', 'out.txt')
    await (await openEditTarget(app, nested)).write('restored')
    await expect(fs.readFile(nested, 'utf-8')).resolves.toBe('restored')
  })

  it('removes the file and tolerates it already being gone', async () => {
    const target = nodePath.join(root, 'out.txt')
    await fs.writeFile(target, 'hello')

    const io = await openEditTarget(app, target)
    await io.trash()
    await expect(io.trash()).resolves.toBeUndefined()

    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('usableSnapshotPair', () => {
  it('rejects a pair whose snapshots are missing on this device', () => {
    expect(usableSnapshotPair(null, snapshot())).toBeNull()
    expect(usableSnapshotPair(snapshot(), null)).toBeNull()
  })

  it('rejects a pair whose content was dropped for being oversized', () => {
    expect(
      usableSnapshotPair(snapshot({ contentAvailable: false }), snapshot()),
    ).toBeNull()
    expect(
      usableSnapshotPair(snapshot(), snapshot({ contentAvailable: false })),
    ).toBeNull()
  })

  it('accepts a pair that still carries both contents', () => {
    const first = snapshot({ beforeContent: 'v1' })
    const latest = snapshot({ afterContent: 'v3' })
    expect(usableSnapshotPair(first, latest)).toEqual({ first, latest })
  })
})
