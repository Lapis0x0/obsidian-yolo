import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'

import { importLegacyImageCache } from './legacyImageCacheImport'
import {
  lookupImageDataUrls,
  resetLocalCacheStateForTests,
} from './localCacheStore'

jest.mock('../../core/paths/yoloManagedData', () => ({
  ensureUserDataRootDir: jest.fn().mockResolvedValue('YOLO/data'),
}))

const LEGACY_DIR = 'YOLO/data/chats/image_cache'
const LEGACY_FILE = `${LEGACY_DIR}/global.json`

const createApp = (files: Map<string, string>, dirs: Set<string>) => {
  const localStorage = new Map<string, string>([
    [
      'yolo-module-device-local-database-namespace',
      '00000000-0000-4000-8000-000000000001',
    ],
  ])
  return {
    loadLocalStorage: (key: string) => localStorage.get(key) ?? null,
    saveLocalStorage: (key: string, value: string) => {
      localStorage.set(key, value)
    },
    vault: {
      adapter: {
        exists: jest.fn(
          async (path: string) => files.has(path) || dirs.has(path),
        ),
        read: jest.fn(async (path: string) => files.get(path) ?? ''),
        rmdir: jest.fn(async (path: string) => {
          dirs.delete(path)
          for (const file of [...files.keys()]) {
            if (file.startsWith(`${path}/`)) files.delete(file)
          }
        }),
      },
    },
  }
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  resetLocalCacheStateForTests()
})

describe('importLegacyImageCache', () => {
  it('imports the old entries under their original keys and removes the old directory', async () => {
    const files = new Map([
      [
        LEGACY_FILE,
        JSON.stringify({
          schemaVersion: 1,
          entries: {
            abc123: {
              hash: 'abc123',
              dataUrl: 'data:image/png;base64,AAAA',
              sourcePath: 'a.png',
              createdAt: 1,
              lastAccessedAt: 2,
            },
          },
        }),
      ],
    ])
    const dirs = new Set([LEGACY_DIR])
    const app = createApp(files, dirs)

    await importLegacyImageCache(app as never, null)

    const found = await lookupImageDataUrls(app, ['abc123'])
    expect(found.get('abc123')).toBe('data:image/png;base64,AAAA')
    expect(dirs.has(LEGACY_DIR)).toBe(false)
  })

  it('removes an unreadable legacy file instead of retrying it forever', async () => {
    const files = new Map([[LEGACY_FILE, '{not json']])
    const dirs = new Set([LEGACY_DIR])
    const app = createApp(files, dirs)

    await importLegacyImageCache(app as never, null)

    expect(dirs.has(LEGACY_DIR)).toBe(false)
  })

  it('does nothing when there is no legacy directory', async () => {
    const app = createApp(new Map(), new Set())

    await importLegacyImageCache(app as never, null)

    expect(app.vault.adapter.rmdir).not.toHaveBeenCalled()
  })
})
