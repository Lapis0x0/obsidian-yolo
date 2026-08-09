jest.mock('obsidian')

import { App, TFile, TFolder } from 'obsidian'

import { createVaultBashFileSystem } from './vaultBashFileSystem'

const basename = (path: string) => path.split('/').pop() ?? path

const makeFile = (path: string, size = 10, mtime = 1000): TFile =>
  Object.assign(new TFile(), {
    path,
    name: basename(path),
    stat: { size, mtime },
  })

const makeFolder = (
  path: string,
  children: Array<TFile | TFolder> = [],
): TFolder =>
  Object.assign(new TFolder(), {
    path,
    name: path ? basename(path) : '',
    children,
  })

function makeApp(entries: Array<TFile | TFolder>) {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]))
  const root = makeFolder(
    '',
    entries.filter((entry) => !entry.path.includes('/')),
  )
  const trashFile = jest.fn(async (file: TFile | TFolder) => {
    byPath.delete(file.path)
  })
  const renameFile = jest.fn(async (file: TFile | TFolder, newPath: string) => {
    byPath.delete(file.path)
    ;(file as { path: string }).path = newPath
    ;(file as { name: string }).name = basename(newPath)
    byPath.set(newPath, file)
  })
  const createFolder = jest.fn(async (path: string) => {
    byPath.set(path, makeFolder(path))
  })
  const app = {
    vault: {
      getRoot: jest.fn(() => root),
      getAbstractFileByPath: jest
        .fn()
        .mockImplementation((path: string) => byPath.get(path) ?? null),
      cachedRead: jest
        .fn()
        .mockImplementation((file: TFile) =>
          Promise.resolve(`content:${file.path}`),
        ),
      readBinary: jest
        .fn()
        .mockImplementation((file: TFile) =>
          Promise.resolve(new TextEncoder().encode(`bin:${file.path}`).buffer),
        ),
      createFolder,
      getAllLoadedFiles: jest.fn(() => [root, ...entries]),
    },
    fileManager: {
      trashFile,
      renameFile,
    },
  } as unknown as App
  return { app, byPath, trashFile, renameFile, createFolder }
}

describe('createVaultBashFileSystem', () => {
  describe('readFile / readFileBuffer', () => {
    it('reads file content via cachedRead', async () => {
      const file = makeFile('notes/a.md')
      const { app } = makeApp([file])
      const fs = createVaultBashFileSystem(app)

      await expect(fs.readFile('notes/a.md')).resolves.toBe(
        'content:notes/a.md',
      )
    })

    it('reads binary content via readBinary', async () => {
      const file = makeFile('assets/a.png')
      const { app } = makeApp([file])
      const fs = createVaultBashFileSystem(app)

      const bytes = await fs.readFileBuffer('assets/a.png')
      expect(new TextDecoder().decode(bytes)).toBe('bin:assets/a.png')
    })

    it('throws for a missing file', async () => {
      const { app } = makeApp([])
      const fs = createVaultBashFileSystem(app)

      await expect(fs.readFile('missing.md')).rejects.toThrow(/ENOENT/)
    })

    it('throws for a directory', async () => {
      const folder = makeFolder('notes')
      const { app } = makeApp([folder])
      const fs = createVaultBashFileSystem(app)

      await expect(fs.readFile('notes')).rejects.toThrow(/EISDIR/)
    })
  })

  describe('exists', () => {
    it('is true for the vault root', async () => {
      const { app } = makeApp([])
      const fs = createVaultBashFileSystem(app)

      await expect(fs.exists('')).resolves.toBe(true)
    })

    it('is true for an existing path and false otherwise', async () => {
      const file = makeFile('a.md')
      const { app } = makeApp([file])
      const fs = createVaultBashFileSystem(app)

      await expect(fs.exists('a.md')).resolves.toBe(true)
      await expect(fs.exists('missing.md')).resolves.toBe(false)
    })
  })

  describe('stat', () => {
    it('reports the vault root as a directory', async () => {
      const { app } = makeApp([])
      const fs = createVaultBashFileSystem(app)

      await expect(fs.stat('')).resolves.toEqual({
        isFile: false,
        isDirectory: true,
        mtimeMs: 0,
        size: 0,
      })
    })

    it('reports file size and mtime', async () => {
      const file = makeFile('a.md', 42, 12345)
      const { app } = makeApp([file])
      const fs = createVaultBashFileSystem(app)

      await expect(fs.stat('a.md')).resolves.toEqual({
        isFile: true,
        isDirectory: false,
        mtimeMs: 12345,
        size: 42,
      })
    })

    it('reports folders as directories', async () => {
      const folder = makeFolder('notes')
      const { app } = makeApp([folder])
      const fs = createVaultBashFileSystem(app)

      await expect(fs.stat('notes')).resolves.toEqual({
        isFile: false,
        isDirectory: true,
        mtimeMs: 0,
        size: 0,
      })
    })

    it('throws for a missing path', async () => {
      const { app } = makeApp([])
      const fs = createVaultBashFileSystem(app)

      await expect(fs.stat('missing.md')).rejects.toThrow(/ENOENT/)
    })
  })

  describe('readdir', () => {
    it('lists root children when path is empty', async () => {
      const file = makeFile('a.md')
      const folder = makeFolder('notes')
      const { app } = makeApp([file, folder])
      const fs = createVaultBashFileSystem(app)

      const entries = await fs.readdir('')
      expect(entries).toEqual(
        expect.arrayContaining([
          { name: 'a.md', isFile: true, isDirectory: false },
          { name: 'notes', isFile: false, isDirectory: true },
        ]),
      )
    })

    it('lists a subfolder children', async () => {
      const child = makeFile('notes/a.md')
      const folder = makeFolder('notes', [child])
      const { app } = makeApp([folder, child])
      const fs = createVaultBashFileSystem(app)

      await expect(fs.readdir('notes')).resolves.toEqual([
        { name: 'a.md', isFile: true, isDirectory: false },
      ])
    })

    it('throws ENOTDIR for a file path', async () => {
      const file = makeFile('a.md')
      const { app } = makeApp([file])
      const fs = createVaultBashFileSystem(app)

      await expect(fs.readdir('a.md')).rejects.toThrow(/ENOTDIR/)
    })

    it('throws for a missing path', async () => {
      const { app } = makeApp([])
      const fs = createVaultBashFileSystem(app)

      await expect(fs.readdir('missing')).rejects.toThrow(/ENOENT/)
    })
  })

  describe('mkdir', () => {
    it('creates a folder when the parent exists', async () => {
      const { app, createFolder } = makeApp([])
      const fs = createVaultBashFileSystem(app)

      await fs.mkdir('notes')
      expect(createFolder).toHaveBeenCalledWith('notes')
    })

    it('throws when the parent is missing and not recursive', async () => {
      const { app } = makeApp([])
      const fs = createVaultBashFileSystem(app)

      await expect(fs.mkdir('a/b/c')).rejects.toThrow(/ENOENT/)
    })

    it('creates the full chain when recursive', async () => {
      const { app, createFolder } = makeApp([])
      const fs = createVaultBashFileSystem(app)

      await fs.mkdir('a/b/c', { recursive: true })
      expect(createFolder).toHaveBeenCalledWith('a')
      expect(createFolder).toHaveBeenCalledWith('a/b')
      expect(createFolder).toHaveBeenCalledWith('a/b/c')
    })

    it('throws EEXIST for an existing path when not recursive', async () => {
      const folder = makeFolder('notes')
      const { app } = makeApp([folder])
      const fs = createVaultBashFileSystem(app)

      await expect(fs.mkdir('notes')).rejects.toThrow(/EEXIST/)
    })

    it('is idempotent for an existing directory when recursive', async () => {
      const folder = makeFolder('notes')
      const { app, createFolder } = makeApp([folder])
      const fs = createVaultBashFileSystem(app)

      await expect(
        fs.mkdir('notes', { recursive: true }),
      ).resolves.toBeUndefined()
      expect(createFolder).not.toHaveBeenCalled()
    })
  })

  describe('rm (maps to the vault trash service)', () => {
    it('trashes a file and reports targetKind file', async () => {
      const file = makeFile('a.md')
      const { app, trashFile } = makeApp([file])
      const fs = createVaultBashFileSystem(app)

      await expect(fs.rm('a.md')).resolves.toEqual({ targetKind: 'file' })
      expect(trashFile).toHaveBeenCalledWith(file)
    })

    it('trashes an empty folder and reports targetKind folder', async () => {
      const folder = makeFolder('notes')
      const { app, trashFile } = makeApp([folder])
      const fs = createVaultBashFileSystem(app)

      await expect(fs.rm('notes')).resolves.toEqual({ targetKind: 'folder' })
      expect(trashFile).toHaveBeenCalledWith(folder)
    })

    it('refuses to trash a non-empty folder without recursive', async () => {
      const child = makeFile('notes/a.md')
      const folder = makeFolder('notes', [child])
      const { app, trashFile } = makeApp([folder, child])
      const fs = createVaultBashFileSystem(app)

      await expect(fs.rm('notes')).rejects.toThrow(/not empty/i)
      expect(trashFile).not.toHaveBeenCalled()
    })

    it('trashes a non-empty folder with recursive', async () => {
      const child = makeFile('notes/a.md')
      const folder = makeFolder('notes', [child])
      const { app, trashFile } = makeApp([folder, child])
      const fs = createVaultBashFileSystem(app)

      await expect(fs.rm('notes', { recursive: true })).resolves.toEqual({
        targetKind: 'folder',
      })
      expect(trashFile).toHaveBeenCalledWith(folder)
    })

    it('throws for a missing path', async () => {
      const { app } = makeApp([])
      const fs = createVaultBashFileSystem(app)

      await expect(fs.rm('missing.md')).rejects.toThrow(/not found/i)
    })
  })

  describe('mv (maps to the vault rename service)', () => {
    it('renames via fileManager.renameFile', async () => {
      const file = makeFile('a.md')
      const { app, renameFile } = makeApp([file])
      const fs = createVaultBashFileSystem(app)

      await fs.mv('a.md', 'b.md')
      expect(renameFile).toHaveBeenCalledWith(file, 'b.md')
    })

    it('refuses to overwrite an existing target', async () => {
      const source = makeFile('a.md')
      const target = makeFile('b.md')
      const { app, renameFile } = makeApp([source, target])
      const fs = createVaultBashFileSystem(app)

      await expect(fs.mv('a.md', 'b.md')).rejects.toThrow(/already exists/i)
      expect(renameFile).not.toHaveBeenCalled()
    })

    it('throws when the source does not exist', async () => {
      const { app } = makeApp([])
      const fs = createVaultBashFileSystem(app)

      await expect(fs.mv('missing.md', 'b.md')).rejects.toThrow(/not found/i)
    })
  })

  describe('getAllPaths', () => {
    it('lists every loaded file and folder except the vault root', () => {
      const file = makeFile('a.md')
      const folder = makeFolder('notes')
      const { app } = makeApp([file, folder])
      const fs = createVaultBashFileSystem(app)

      expect(fs.getAllPaths().sort()).toEqual(['a.md', 'notes'])
    })
  })

  describe('hidden user data root', () => {
    const settings = { yolo: { baseDir: 'YOLO' } }

    it('reports the user data root and its contents as non-existent', async () => {
      const dataFolder = makeFolder('YOLO/data')
      const chatFile = makeFile('YOLO/data/chats/v1_abc.json')
      const { app } = makeApp([dataFolder, chatFile])
      const fs = createVaultBashFileSystem(app, undefined, settings)

      await expect(fs.exists('YOLO/data')).resolves.toBe(false)
      await expect(fs.exists('YOLO/data/chats/v1_abc.json')).resolves.toBe(
        false,
      )
      await expect(fs.readFile('YOLO/data/chats/v1_abc.json')).rejects.toThrow(
        /ENOENT/,
      )
      await expect(fs.stat('YOLO/data/chats/v1_abc.json')).rejects.toThrow(
        /ENOENT/,
      )
      await expect(fs.readdir('YOLO/data')).rejects.toThrow(/ENOENT/)
    })

    it('excludes the user data root from a parent directory listing', async () => {
      const baseDir = makeFolder('YOLO', [
        makeFile('YOLO/snippets.md'),
        makeFolder('YOLO/data'),
      ])
      const { app } = makeApp([baseDir])
      const fs = createVaultBashFileSystem(app, undefined, settings)

      await expect(fs.readdir('YOLO')).resolves.toEqual([
        { name: 'snippets.md', isFile: true, isDirectory: false },
      ])
    })

    it('excludes the user data root from getAllPaths', () => {
      const chatFile = makeFile('YOLO/data/chats/v1_abc.json')
      const otherFile = makeFile('YOLO/snippets.md')
      const { app } = makeApp([chatFile, otherFile])
      const fs = createVaultBashFileSystem(app, undefined, settings)

      expect(fs.getAllPaths()).toEqual(['YOLO/snippets.md'])
    })

    it('refuses to write into or remove the user data root', async () => {
      const dataFolder = makeFolder('YOLO/data')
      const { app } = makeApp([dataFolder])
      const fs = createVaultBashFileSystem(app, undefined, settings)

      await expect(fs.mkdir('YOLO/data/new-dir')).rejects.toThrow(/ENOENT/)
      await expect(fs.rm('YOLO/data')).rejects.toThrow(/ENOENT/)
      await expect(fs.mv('YOLO/data', 'YOLO/moved')).rejects.toThrow(/ENOENT/)
    })

    it('still guards the default baseDir root when settings are not supplied', () => {
      // `getYoloUserDataRootDir` falls back to the default `YOLO` baseDir
      // when settings are missing entirely, so the guard stays in effect
      // rather than silently disabling itself.
      const chatFile = makeFile('YOLO/data/chats/v1_abc.json')
      const otherFile = makeFile('Notes/a.md')
      const { app } = makeApp([chatFile, otherFile])
      const fs = createVaultBashFileSystem(app)

      expect(fs.getAllPaths()).toEqual(['Notes/a.md'])
    })
  })

  describe('workspace scope enforcement', () => {
    const scope = {
      enabled: true,
      include: ['projects/foo'],
      exclude: [],
    }

    it('denies reads outside the included scope', async () => {
      const inScope = makeFile('projects/foo/a.md')
      const outOfScope = makeFile('other/b.md')
      const { app } = makeApp([inScope, outOfScope])
      const fs = createVaultBashFileSystem(app, scope)

      await expect(fs.readFile('projects/foo/a.md')).resolves.toBe(
        'content:projects/foo/a.md',
      )
      await expect(fs.readFile('other/b.md')).rejects.toThrow(/EACCES/)
    })

    it('reports out-of-scope paths as non-existent', async () => {
      const outOfScope = makeFile('other/b.md')
      const { app } = makeApp([outOfScope])
      const fs = createVaultBashFileSystem(app, scope)

      await expect(fs.exists('other/b.md')).resolves.toBe(false)
    })

    it('allows traversal through an ancestor of an include rule', async () => {
      const fooFile = makeFile('projects/foo/a.md')
      const fooFolder = makeFolder('projects/foo', [fooFile])
      const barFolder = makeFolder('projects/bar')
      const projectsFolder = makeFolder('projects', [fooFolder, barFolder])
      const { app } = makeApp([projectsFolder, fooFolder, barFolder, fooFile])
      const fs = createVaultBashFileSystem(app, scope)

      // "projects" itself is only an ancestor of the include rule, not
      // in-scope content — listing it must succeed (to allow descending)
      // but must hide the sibling "bar" folder that isn't in scope.
      const entries = await fs.readdir('projects')
      expect(entries).toEqual([
        { name: 'foo', isFile: false, isDirectory: true },
      ])
    })

    it('denies rm/mv for out-of-scope targets', async () => {
      const outOfScope = makeFile('other/b.md')
      const { app, trashFile, renameFile } = makeApp([outOfScope])
      const fs = createVaultBashFileSystem(app, scope)

      await expect(fs.rm('other/b.md')).rejects.toThrow(/EACCES/)
      expect(trashFile).not.toHaveBeenCalled()
      await expect(fs.mv('other/b.md', 'projects/foo/b.md')).rejects.toThrow(
        /EACCES/,
      )
      expect(renameFile).not.toHaveBeenCalled()
    })

    it('excludes out-of-scope paths from getAllPaths', () => {
      const inScope = makeFile('projects/foo/a.md')
      const outOfScope = makeFile('other/b.md')
      const { app } = makeApp([inScope, outOfScope])
      const fs = createVaultBashFileSystem(app, scope)

      expect(fs.getAllPaths()).toEqual(['projects/foo/a.md'])
    })
  })
})
