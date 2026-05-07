import { createObsidianRuntimeVault } from './obsidianRuntimeVault'

describe('createObsidianRuntimeVault', () => {
  const mockGetActiveFile = jest.fn()
  const mockRead = jest.fn()
  const mockGetMarkdownFiles = jest.fn()
  const mockGetFileByPath = jest.fn()
  const mockGetAbstractFileByPath = jest.fn()
  const mockCreateFolder = jest.fn()
  const mockModify = jest.fn()
  const mockTrashFile = jest.fn()
  const mockAdapterExists = jest.fn()
  const mockAdapterStat = jest.fn()

  const mockApp = {
    workspace: {
      getActiveFile: mockGetActiveFile,
      getLeavesOfType: jest.fn(),
      getLeaf: jest.fn(),
    },
    vault: {
      read: mockRead,
      readBinary: jest.fn(),
      createFolder: mockCreateFolder,
      create: jest.fn(),
      modify: mockModify,
      getAbstractFileByPath: mockGetAbstractFileByPath,
      getFileByPath: mockGetFileByPath,
      getMarkdownFiles: mockGetMarkdownFiles,
      getAllLoadedFiles: jest.fn(() => []),
      adapter: {
        exists: mockAdapterExists,
        stat: mockAdapterStat,
      },
    },
    fileManager: {
      trashFile: mockTrashFile,
    },
  } as any

  beforeEach(() => {
    jest.clearAllMocks()
    mockAdapterExists.mockResolvedValue(false)
    mockAdapterStat.mockResolvedValue(null)
  })

  describe('getActiveFile', () => {
    it('returns file ref when a file is active', () => {
      mockGetActiveFile.mockReturnValue({
        path: 'test/note.md',
        name: 'note.md',
        basename: 'note',
        extension: 'md',
      })

      const result = createObsidianRuntimeVault(mockApp).getActiveFile()

      expect(result).toEqual({
        path: 'test/note.md',
        name: 'note.md',
        basename: 'note',
        extension: 'md',
      })
    })

    it('returns null when no file is active', () => {
      mockGetActiveFile.mockReturnValue(null)

      const result = createObsidianRuntimeVault(mockApp).getActiveFile()

      expect(result).toBeNull()
    })
  })

  describe('read', () => {
    it('reads file content via vault', async () => {
      const file = { path: 'test/note.md', name: 'note.md', basename: 'note', extension: 'md' }
      mockGetFileByPath.mockReturnValue(file)
      mockRead.mockResolvedValue('# Markdown content')

      const result = await createObsidianRuntimeVault(mockApp).read(file)

      expect(mockRead).toHaveBeenCalledWith(file)
      expect(result).toBe('# Markdown content')
    })

    it('resolves string paths before reading', async () => {
      const file = {
        path: 'test/note.md',
        name: 'note.md',
        basename: 'note',
        extension: 'md',
      }
      mockGetFileByPath.mockReturnValue(file)
      mockRead.mockResolvedValue('# Markdown content')

      const result = await createObsidianRuntimeVault(mockApp).read(
        'test/note.md',
      )

      expect(mockGetFileByPath).toHaveBeenCalledWith('test/note.md')
      expect(mockRead).toHaveBeenCalledWith(file)
      expect(result).toBe('# Markdown content')
    })
  })

  describe('search', () => {
    it('returns matching files filtered by path', async () => {
      mockGetMarkdownFiles.mockReturnValue([
        { path: 'test/note.md', name: 'note.md', basename: 'note', extension: 'md' },
        {
          path: 'docs/readme.md',
          name: 'readme.md',
          basename: 'readme',
          extension: 'md',
        },
        {
          path: 'other/foo.md',
          name: 'foo.md',
          basename: 'foo',
          extension: 'md',
        },
      ])

      const result = await createObsidianRuntimeVault(mockApp).search('test')

      expect(result).toEqual([
        { path: 'test/note.md', name: 'note.md', basename: 'note', extension: 'md' },
      ])
    })

    it('is case-insensitive', async () => {
      mockGetMarkdownFiles.mockReturnValue([
        {
          path: 'TEST/Note.md',
          name: 'Note.md',
          basename: 'Note',
          extension: 'md',
        },
        { path: 'other/file.md', name: 'file.md', basename: 'file', extension: 'md' },
      ])

      const result = await createObsidianRuntimeVault(mockApp).search('test')

      expect(result).toHaveLength(1)
      expect(result[0].path).toBe('TEST/Note.md')
    })

    it('returns empty array when no files match', async () => {
      mockGetMarkdownFiles.mockReturnValue([
        { path: 'a.md', name: 'a.md', basename: 'a', extension: 'md' },
        { path: 'b.md', name: 'b.md', basename: 'b', extension: 'md' },
      ])

      const result = await createObsidianRuntimeVault(mockApp).search('zzzz')

      expect(result).toEqual([])
    })

    it('limits results to 50 files', async () => {
      const files = Array.from({ length: 100 }, (_, i) => ({
        path: `test/file-${i}.md`,
        name: `file-${i}.md`,
        basename: `file-${i}`,
        extension: 'md',
      }))
      mockGetMarkdownFiles.mockReturnValue(files)

      const result = await createObsidianRuntimeVault(mockApp).search('test')

      expect(result).toHaveLength(50)
    })
  })

  describe('createFolder', () => {
    it('creates missing parent folders recursively', async () => {
      const existingFolders = new Set<string>()
      mockAdapterStat.mockImplementation(async (path: string) =>
        existingFolders.has(path) ? { type: 'folder' } : null,
      )
      mockCreateFolder.mockImplementation(async (path: string) => {
        existingFolders.add(path)
      })

      await createObsidianRuntimeVault(mockApp).createFolder(
        'YOLO/.yolo_json_db/chats',
      )

      expect(mockCreateFolder.mock.calls).toEqual([
        ['YOLO'],
        ['YOLO/.yolo_json_db'],
        ['YOLO/.yolo_json_db/chats'],
      ])
    })

    it('does not recreate folders that already exist', async () => {
      mockAdapterStat.mockResolvedValue({ type: 'folder' })

      await createObsidianRuntimeVault(mockApp).createFolder(
        'YOLO/.yolo_json_db/chats',
      )

      expect(mockCreateFolder).not.toHaveBeenCalled()
    })
  })

  describe('modify', () => {
    it('resolves string paths before modifying', async () => {
      const file = {
        path: 'test/note.md',
        name: 'note.md',
        basename: 'note',
        extension: 'md',
      }
      mockGetFileByPath.mockReturnValue(file)
      mockModify.mockResolvedValue(undefined)

      await createObsidianRuntimeVault(mockApp).modify(
        'test/note.md',
        '# Updated',
      )

      expect(mockModify).toHaveBeenCalledWith(file, '# Updated')
    })
  })

  describe('trashFile', () => {
    it('resolves string paths before trashing', async () => {
      const file = {
        path: 'test/note.md',
        name: 'note.md',
      }
      mockGetAbstractFileByPath.mockReturnValue(file)
      mockTrashFile.mockResolvedValue(undefined)

      await createObsidianRuntimeVault(mockApp).trashFile('test/note.md')

      expect(mockTrashFile).toHaveBeenCalledWith(file)
    })
  })
})
