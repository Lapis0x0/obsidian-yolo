jest.mock('obsidian', () => {
  class TFile {}
  class TFolder {}
  class FileSystemAdapter {
    getBasePath(): string {
      return '/vault'
    }
  }
  return {
    TFile,
    TFolder,
    FileSystemAdapter,
    Platform: { isDesktopApp: true },
  }
})

const getPathForFile = jest.fn<string, [File]>()
jest.mock('electron', () => ({ webUtils: { getPathForFile } }), {
  virtual: true,
})

import { type App, FileSystemAdapter, TFile, TFolder } from 'obsidian'

import { canAcceptDrop, resolveDrop } from './resolveDrop'

const createFile = (path: string): TFile =>
  Object.assign(new TFile(), {
    path,
    name: path.split('/').pop() ?? path,
  })

const createFolder = (path: string): TFolder =>
  Object.assign(new TFolder(), {
    path,
    name: path.split('/').pop() ?? path,
  })

const createApp = ({
  entries = [],
  draggable,
}: {
  entries?: Array<TFile | TFolder>
  draggable?: { file?: unknown; files?: unknown[] }
} = {}): App => {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]))
  return {
    vault: {
      getName: () => 'vault',
      adapter: new FileSystemAdapter(),
      getAbstractFileByPath: (path: string) => byPath.get(path) ?? null,
    },
    metadataCache: {
      getFirstLinkpathDest: (linkpath: string) => {
        const entry = byPath.get(linkpath) ?? byPath.get(`${linkpath}.md`)
        return entry instanceof TFile ? entry : null
      },
    },
    dragManager: { draggable },
  } as unknown as App
}

type DroppedFixture = {
  file: File
  isDirectory: boolean
}

const createDataTransfer = ({
  types = [],
  data = {},
  dropped = [],
}: {
  types?: string[]
  data?: Record<string, string>
  dropped?: DroppedFixture[]
} = {}): DataTransfer =>
  ({
    types,
    files: dropped.map(({ file }) => file),
    items: dropped.map(({ file, isDirectory }) => ({
      kind: 'file',
      getAsFile: () => file,
      webkitGetAsEntry: () => ({ isDirectory }),
    })),
    getData: (type: string) => data[type] ?? '',
  }) as unknown as DataTransfer

const createDroppedFile = ({
  name,
  type = 'text/markdown',
  size = 10,
  path,
  isDirectory = false,
}: {
  name: string
  type?: string
  size?: number
  path?: string
  isDirectory?: boolean
}): DroppedFixture => {
  const file = { name, type, size } as unknown as File
  if (path !== undefined) {
    getPathForFile.mockImplementation((candidate) =>
      candidate === file ? path : '',
    )
  }
  return { file, isDirectory }
}

beforeEach(() => {
  getPathForFile.mockReset()
  getPathForFile.mockReturnValue('')
})

describe('canAcceptDrop', () => {
  it('accepts an external file drag from its dataTransfer types', () => {
    expect(
      canAcceptDrop(createApp(), createDataTransfer({ types: ['Files'] })),
    ).toBe(true)
  })

  it('accepts an internal drag, whose folder is only visible in Obsidian drag state', () => {
    const app = createApp({ draggable: { file: createFolder('Notes') } })

    // An internal drag carries no 'Files' type — recognising it from the
    // dataTransfer alone is exactly what used to make the hint inconsistent.
    expect(
      canAcceptDrop(app, createDataTransfer({ types: ['text/plain'] })),
    ).toBe(true)
  })

  it('ignores a plain text drag', () => {
    expect(
      canAcceptDrop(
        createApp(),
        createDataTransfer({ types: ['text/plain', 'text/html'] }),
      ),
    ).toBe(false)
  })
})

describe('resolveDrop', () => {
  it('resolves an internally dragged folder into a folder mentionable', () => {
    const folder = createFolder('Notes')
    const app = createApp({ entries: [folder], draggable: { file: folder } })

    expect(resolveDrop(app, createDataTransfer())).toEqual({
      mentionables: [{ type: 'folder', folder }],
      files: [],
    })
  })

  it('resolves an obsidian:// uri into a file mentionable', () => {
    const file = createFile('Notes/note.md')
    const app = createApp({ entries: [file] })
    const dataTransfer = createDataTransfer({
      types: ['text/uri-list'],
      data: {
        'text/uri-list': 'obsidian://open?vault=vault&file=Notes%2Fnote.md',
      },
    })

    expect(resolveDrop(app, dataTransfer)).toEqual({
      mentionables: [{ type: 'file', file }],
      files: [],
    })
  })

  it('resolves an externally dropped directory into a local-folder mentionable', () => {
    // 352 is the inode size macOS reports for a dropped directory. Reading
    // "size 0" as the directory signal is what sent a dropped folder down the
    // unsupported-attachment path.
    const dropped = createDroppedFile({
      name: '新建文件夹',
      type: '',
      size: 352,
      path: '/Users/me/新建文件夹',
      isDirectory: true,
    })

    expect(
      resolveDrop(createApp(), createDataTransfer({ dropped: [dropped] })),
    ).toEqual({
      mentionables: [{ type: 'local-folder', path: '/Users/me/新建文件夹' }],
      files: [],
    })
  })

  it('resolves a directory dropped from inside the vault into the same mentionable an internal drag produces', () => {
    const folder = createFolder('Notes')
    const dropped = createDroppedFile({
      name: 'Notes',
      type: '',
      size: 352,
      path: '/vault/Notes',
      isDirectory: true,
    })

    expect(
      resolveDrop(
        createApp({ entries: [folder] }),
        createDataTransfer({ dropped: [dropped] }),
      ),
    ).toEqual({
      mentionables: [{ type: 'folder', folder }],
      files: [],
    })
  })

  it('leaves an external file to the attachment flow', () => {
    const dropped = createDroppedFile({
      name: 'notes.md',
      path: '/Users/me/notes.md',
    })

    expect(
      resolveDrop(createApp(), createDataTransfer({ dropped: [dropped] })),
    ).toEqual({
      mentionables: [],
      files: [dropped.file],
    })
  })

  it('does not duplicate an item reported by both the drag state and the uri list', () => {
    const file = createFile('Notes/note.md')
    const app = createApp({ entries: [file], draggable: { file } })
    const dataTransfer = createDataTransfer({
      types: ['text/uri-list'],
      data: {
        'text/uri-list': 'obsidian://open?vault=vault&file=Notes%2Fnote.md',
      },
    })

    expect(resolveDrop(app, dataTransfer).mentionables).toEqual([
      { type: 'file', file },
    ])
  })

  it('ignores an obsidian:// uri pointing at a different vault', () => {
    const file = createFile('Notes/note.md')
    const app = createApp({ entries: [file] })
    const dataTransfer = createDataTransfer({
      types: ['text/uri-list'],
      data: {
        'text/uri-list': 'obsidian://open?vault=other&file=Notes%2Fnote.md',
      },
    })

    expect(resolveDrop(app, dataTransfer).mentionables).toEqual([])
  })
})
