import type { YoloVaultIndexEntry } from '../yoloRuntime.types'

import { fetchInitialVaultIndex } from './fetchInitialVaultIndex'

describe('fetchInitialVaultIndex', () => {
  it('filters the root folder entry from /api/vault/index', async () => {
    const api = {
      getJson: jest.fn(async (path: string) => {
        if (path === '/api/vault/index') {
          return [
            {
              kind: 'folder',
              path: '/',
              name: '',
              basename: '',
              extension: '',
            },
            {
              kind: 'folder',
              path: 'docs',
              name: 'docs',
              basename: 'docs',
              extension: '',
            },
            {
              kind: 'file',
              path: 'docs/a.md',
              name: 'a.md',
              basename: 'a',
              extension: 'md',
            },
          ] satisfies YoloVaultIndexEntry[]
        }

        throw new Error(`Unexpected path: ${path}`)
      }),
    }

    await expect(fetchInitialVaultIndex(api as never)).resolves.toEqual([
      {
        kind: 'folder',
        path: 'docs',
        name: 'docs',
        basename: 'docs',
        extension: '',
      },
      {
        kind: 'file',
        path: 'docs/a.md',
        name: 'a.md',
        basename: 'a',
        extension: 'md',
      },
    ])
  })

  it('falls back to recursive /api/vault/list when index has no files', async () => {
    const api = {
      getJson: jest.fn(async (path: string) => {
        if (path === '/api/vault/index') {
          return [
            {
              kind: 'folder',
              path: '/',
              name: '',
              basename: '',
              extension: '',
            },
            {
              kind: 'folder',
              path: 'docs',
              name: 'docs',
              basename: 'docs',
              extension: '',
            },
          ] satisfies YoloVaultIndexEntry[]
        }

        if (path === '/api/vault/list?path=%2F') {
          return {
            files: [],
            folders: ['docs'],
          }
        }

        if (path === '/api/vault/list?path=docs') {
          return {
            files: ['docs/a.md'],
            folders: ['docs/nested'],
          }
        }

        if (path === '/api/vault/list?path=docs%2Fnested') {
          return {
            files: ['docs/nested/b.png'],
            folders: [],
          }
        }

        throw new Error(`Unexpected path: ${path}`)
      }),
    }

    await expect(fetchInitialVaultIndex(api as never)).resolves.toEqual([
      {
        kind: 'folder',
        path: 'docs',
        name: 'docs',
        basename: 'docs',
        extension: '',
      },
      {
        kind: 'file',
        path: 'docs/a.md',
        name: 'a.md',
        basename: 'a',
        extension: 'md',
      },
      {
        kind: 'folder',
        path: 'docs/nested',
        name: 'nested',
        basename: 'nested',
        extension: '',
      },
      {
        kind: 'file',
        path: 'docs/nested/b.png',
        name: 'b.png',
        basename: 'b',
        extension: 'png',
      },
    ])
  })

  it('still crawls indexed folders when listing the root path fails', async () => {
    const api = {
      getJson: jest.fn(async (path: string) => {
        if (path === '/api/vault/index') {
          return [
            {
              kind: 'folder',
              path: '/',
              name: '',
              basename: '',
              extension: '',
            },
            {
              kind: 'folder',
              path: 'docs',
              name: 'docs',
              basename: 'docs',
              extension: '',
            },
          ] satisfies YoloVaultIndexEntry[]
        }

        if (path === '/api/vault/list?path=%2F') {
          throw new Error('root listing not supported')
        }

        if (path === '/api/vault/list?path=docs') {
          return {
            files: ['docs/a.md'],
            folders: [],
          }
        }

        throw new Error(`Unexpected path: ${path}`)
      }),
    }

    await expect(fetchInitialVaultIndex(api as never)).resolves.toEqual([
      {
        kind: 'folder',
        path: 'docs',
        name: 'docs',
        basename: 'docs',
        extension: '',
      },
      {
        kind: 'file',
        path: 'docs/a.md',
        name: 'a.md',
        basename: 'a',
        extension: 'md',
      },
    ])
  })
})
