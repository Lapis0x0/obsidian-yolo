import { FileAnkiImportJournalStorage } from './journalStorage'

describe('FileAnkiImportJournalStorage', () => {
  it('uses the current data root and only accepts journal-owned paths', async () => {
    const files = new Map<string, string>()
    const folders = new Set<string>()
    const port = {
      exists: async (path: string) => files.has(path) || folders.has(path),
      mkdir: async (path: string) => void folders.add(path),
      write: async (path: string, content: string) =>
        void files.set(path, content),
      list: async (path: string) => ({
        files: [...files.keys()].filter((item) => item.startsWith(`${path}/`)),
      }),
      read: async (path: string) => files.get(path) ?? '',
      remove: async (path: string) => void files.delete(path),
    }
    let root = 'First/.yolo_json_db'
    const storage = new FileAnkiImportJournalStorage(port, async () => root)

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
    expect(() => storage.read('foreign.json')).toThrow(
      'Unknown Anki import journal path',
    )
  })
})
