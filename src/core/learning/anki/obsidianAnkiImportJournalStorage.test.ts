import type { App } from 'obsidian'

import { ObsidianAnkiImportJournalStorage } from './obsidianAnkiImportJournalStorage'

describe('ObsidianAnkiImportJournalStorage', () => {
  it('uses the current learning data root for each new journal', async () => {
    const files = new Map<string, string>()
    const folders = new Set<string>()
    const adapter = {
      exists: jest.fn(async (path: string) =>
        Promise.resolve(files.has(path) || folders.has(path)),
      ),
      mkdir: jest.fn(async (path: string) => {
        folders.add(path)
      }),
      write: jest.fn(async (path: string, content: string) => {
        files.set(path, content)
      }),
      list: jest.fn(async (path: string) => ({
        files: [...files.keys()].filter((file) => file.startsWith(`${path}/`)),
        folders: [],
      })),
      read: jest.fn(async (path: string) => files.get(path) ?? ''),
      remove: jest.fn(async (path: string) => {
        files.delete(path)
      }),
    }
    const app = { vault: { adapter } } as unknown as App
    let root = 'First/.yolo_json_db'
    const storage = new ObsidianAnkiImportJournalStorage(app, async () => root)

    const first = await storage.create('{}')
    root = 'Second/.yolo_json_db'
    const second = await storage.create('{}')

    expect(first).toMatch(
      /^First\/.yolo_json_db\/anki-import-journals\/.+\.json$/,
    )
    expect(second).toMatch(
      /^Second\/.yolo_json_db\/anki-import-journals\/.+\.json$/,
    )
    await expect(storage.list()).resolves.toEqual([second])
  })
})
