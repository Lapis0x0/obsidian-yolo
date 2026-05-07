import { createWebCompatApp, type WebVaultIndexEntry } from './createWebCompatApp'

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: unknown }) => children,
}))

jest.mock('remark-gfm', () => ({
  __esModule: true,
  default: {},
}))

jest.mock('turndown', () => ({
  __esModule: true,
  default: class MockTurndownService {
    turndown(html: string): string {
      return html
    }
  },
}))

describe('createWebCompatApp', () => {
  const mockApi = {
    getJson: jest.fn(),
    getArrayBuffer: jest.fn(),
    postJson: jest.fn(),
    postArrayBuffer: jest.fn(),
  }

  const initialIndex: WebVaultIndexEntry[] = [
    {
      kind: 'folder',
      path: 'Docs',
      name: 'Docs',
      basename: 'Docs',
      extension: '',
    },
    {
      kind: 'file',
      path: 'Docs/test.md',
      name: 'test.md',
      basename: 'test',
      extension: 'md',
      stat: {
        ctime: 10,
        mtime: 20,
        size: 30,
      },
    },
  ]

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('exposes Obsidian-like vault collection helpers', () => {
    const app = createWebCompatApp({
      api: mockApi as any,
      vaultName: 'Test Vault',
      initialIndex,
      initialActiveFile: null,
    })

    expect(app.vault.getFiles().map((file: { path: string }) => file.path)).toEqual([
      'Docs/test.md',
    ])
    expect(
      app.vault.getAllFolders().map((folder: { path: string }) => folder.path),
    ).toEqual(['Docs'])
    expect(
      app.vault
        .getAllFolders(true)
        .map((folder: { path: string }) => folder.path),
    ).toEqual(['/', 'Docs'])
    expect(app.vault.getRoot().path).toBe('/')
    expect(app.vault.getFileByPath('Docs/test.md')?.stat).toEqual({
      type: 'file',
      ctime: 10,
      mtime: 20,
      size: 30,
    })
    expect(app.vault.getFileByPath('Docs/test.md')).toMatchObject({
      name: 'test.md',
      basename: 'test',
      extension: 'md',
    })
  })

  it('uses adapter write as an upsert and updates local file state', async () => {
    const app = createWebCompatApp({
      api: mockApi as any,
      vaultName: 'Test Vault',
      initialIndex,
      initialActiveFile: null,
    })

    mockApi.postJson.mockResolvedValue({ ok: true })
    await app.vault.adapter.write('Docs/new.md', '# hello')

    expect(mockApi.postJson).toHaveBeenCalledWith('/api/vault/write', {
      path: 'Docs/new.md',
      content: '# hello',
    })
    expect(app.vault.getFileByPath('Docs/new.md')?.stat).toMatchObject({
      type: 'file',
      size: new TextEncoder().encode('# hello').byteLength,
    })
  })

  it('exposes adapter list and stat from the local file graph', async () => {
    const app = createWebCompatApp({
      api: mockApi as any,
      vaultName: 'Test Vault',
      initialIndex,
      initialActiveFile: null,
    })

    await expect(app.vault.adapter.list('Docs')).resolves.toEqual({
      files: ['Docs/test.md'],
      folders: [],
    })
    await expect(app.vault.adapter.stat('Docs/test.md')).resolves.toEqual({
      type: 'file',
      ctime: 10,
      mtime: 20,
      size: 30,
    })
    await expect(app.vault.adapter.stat('Docs')).resolves.toEqual({
      type: 'folder',
      ctime: 0,
      mtime: 0,
      size: 0,
    })
  })
})
