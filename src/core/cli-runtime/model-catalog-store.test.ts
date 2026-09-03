import type { App } from 'obsidian'

import { VaultCliModelCatalogStore } from './model-catalog-store'

const createMemoryApp = () => {
  const files = new Map<string, string>()
  const directories = new Set<string>()
  const adapter = {
    exists: jest.fn(
      async (path: string) => files.has(path) || directories.has(path),
    ),
    mkdir: jest.fn(async (path: string) => {
      directories.add(path)
    }),
    read: jest.fn(async (path: string) => {
      const value = files.get(path)
      if (value === undefined) throw new Error(`Missing file: ${path}`)
      return value
    }),
    write: jest.fn(async (path: string, content: string) => {
      files.set(path, content)
    }),
  }
  return { app: { vault: { adapter } } as unknown as App }
}

describe('VaultCliModelCatalogStore', () => {
  it('round-trips a Grok ACP model catalog', async () => {
    const { app } = createMemoryApp()
    const store = new VaultCliModelCatalogStore(app, () => null)
    await store.write(
      new Map([
        [
          'grok',
          [
            {
              id: 'grok-4.6',
              label: 'Grok 4.6',
              reasoningEfforts: [],
              isDefault: true,
            },
          ],
        ],
      ]),
    )

    await expect(store.read()).resolves.toEqual(
      new Map([
        [
          'grok',
          [
            {
              id: 'grok-4.6',
              label: 'Grok 4.6',
              reasoningEfforts: [],
              isDefault: true,
            },
          ],
        ],
      ]),
    )
  })
})
