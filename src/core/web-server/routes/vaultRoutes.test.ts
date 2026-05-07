import { WebRouter } from '../WebRouter'
import { registerVaultRoutes } from './vaultRoutes'

jest.mock('../../../runtime/obsidian/obsidianRuntimeVault', () => ({
  createObsidianRuntimeVault: jest.fn(() => ({
    getActiveFile: jest.fn(() => ({
      path: 'test/note.md',
      name: 'note.md',
      basename: 'note',
      extension: 'md',
    })),
    read: jest.fn((path: string) => {
      if (path === 'test/note.md') return Promise.resolve('# Hello')
      return Promise.reject(new Error('Not found'))
    }),
    search: jest.fn((query: string) => {
      if (query === 'test') {
        return Promise.resolve([{ path: 'test/note.md', name: 'note.md', basename: 'note', extension: 'md' }])
      }
      return Promise.resolve([])
    }),
  })),
}))

describe('vaultRoutes', () => {
  let router: WebRouter
  let jsonMock: jest.Mock

  beforeEach(() => {
    router = new WebRouter()
    jsonMock = jest.fn()
    const ctx = {
      plugin: { app: {} },
      server: { router, json: jsonMock },
    } as any
    registerVaultRoutes(ctx)
  })

  describe('GET /api/vault/active-file', () => {
    it('returns active file info', () => {
      const handler = router.resolve('GET', '/api/vault/active-file')
      expect(handler).not.toBeNull()
      handler!.handler({ url: '/api/vault/active-file' } as any, {} as any, handler!.params)
      expect(jsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
        path: 'test/note.md',
        name: 'note.md',
        basename: 'note',
        extension: 'md',
      })
    })
  })

  describe('GET /api/vault/search', () => {
    it('returns search results for matching query', async () => {
      const handler = router.resolve('GET', '/api/vault/search')
      expect(handler).not.toBeNull()
      await handler!.handler(
        { url: '/api/vault/search?query=test' } as any,
        {} as any,
        handler!.params,
      )
      expect(jsonMock).toHaveBeenCalledWith(expect.anything(), 200, [
        { path: 'test/note.md', name: 'note.md', basename: 'note', extension: 'md' },
      ])
    })

    it('returns 400 when query param is missing', async () => {
      const handler = router.resolve('GET', '/api/vault/search')
      expect(handler).not.toBeNull()
      await handler!.handler(
        { url: '/api/vault/search' } as any,
        {} as any,
        handler!.params,
      )
      expect(jsonMock).toHaveBeenCalledWith(expect.anything(), 400, {
        error: 'Missing query param',
      })
    })
  })
})
