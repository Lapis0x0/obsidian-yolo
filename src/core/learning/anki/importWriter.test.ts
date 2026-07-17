import { TFile, TFolder } from 'obsidian'
import type { App } from 'obsidian'

import { ObsidianLearningSrsStorage } from '../srs/obsidianLearningSrsStorage'
import { LearningSrsStore } from '../srs/srsStore'

import type { AnkiImportPlan } from './importPlan'
import { commitAnkiImportPlan, recoverAnkiImports } from './importWriter'

jest.mock('../projectScanner', () => ({
  scanProject: jest.fn(async () => ({ kind: 'cards' })),
}))

const makePlan = (): AnkiImportPlan => ({
  version: 1,
  projectName: 'Deck',
  projectSlug: 'Deck',
  baseDir: 'Learning',
  projectPath: 'Learning/Deck',
  chapters: [
    {
      title: 'Deck',
      slug: 'Deck',
      cards: [
        {
          ankiCardId: 1,
          uuid: 'aaaaaaaa',
          title: 'Question',
          front: 'Question {{anki-media:image:pic.png}}',
          back: 'Answer',
        },
      ],
    },
  ],
  assets: [
    {
      sourceName: 'pic.png',
      fileName: 'hash.png',
      bytes: new Uint8Array([1, 2]),
    },
  ],
  srsState: {
    version: 3,
    cards: {
      aaaaaaaa: {
        due: '2026-01-01T00:00:00.000Z',
        stability: 0,
        difficulty: 0,
        elapsedDays: 0,
        scheduledDays: 0,
        learningSteps: 0,
        reps: 0,
        lapses: 0,
        state: 0,
        introducedAt: '2026-01-01T00:00:00.000Z',
      },
    },
    suspended: [],
    pausedAt: null,
    lastStudiedAt: null,
  },
  cardCount: 1,
  warnings: [],
})

const createSrsStore = (app: App): LearningSrsStore =>
  new LearningSrsStore(new ObsidianLearningSrsStorage(app, () => null))

function createApp(failPath?: string) {
  const text = new Map<string, string>()
  const binary = new Map<string, ArrayBuffer>()
  const folders = new Set<string>()
  const folderObjects = new Map<string, object>()
  const fileObjects = new Map<string, object>()
  const adapter = {
    exists: jest.fn(async (path: string) =>
      Promise.resolve(text.has(path) || binary.has(path) || folders.has(path)),
    ),
    mkdir: jest.fn(async (path: string) => {
      folders.add(path)
      const folder = new (TFolder as unknown as new () => {
        path: string
        name: string
        children: object[]
      })()
      folder.path = path
      folder.name = path.split('/').at(-1) ?? path
      folder.children = []
      folderObjects.set(path, folder)
    }),
    write: jest.fn(async (path: string, content: string) => {
      text.set(path, content)
    }),
    read: jest.fn(async (path: string) => {
      const content = text.get(path)
      if (content === undefined) throw new Error(`Missing: ${path}`)
      return content
    }),
    writeBinary: jest.fn(async (path: string, bytes: ArrayBuffer) => {
      binary.set(path, bytes)
    }),
    readBinary: jest.fn(async (path: string) => {
      const bytes = binary.get(path)
      if (!bytes) throw new Error(`Missing: ${path}`)
      return bytes
    }),
    stat: jest.fn(async (path: string) => {
      if (folders.has(path))
        return { type: 'folder' as const, size: 0, mtime: 0 }
      if (text.has(path))
        return {
          type: 'file' as const,
          size: text.get(path)?.length ?? 0,
          mtime: 0,
        }
      if (binary.has(path))
        return {
          type: 'file' as const,
          size: binary.get(path)?.byteLength ?? 0,
          mtime: 0,
        }
      return null
    }),
    remove: jest.fn(async (path: string) => {
      text.delete(path)
      binary.delete(path)
      fileObjects.delete(path)
    }),
    rmdir: jest.fn(async (path: string) => {
      folders.delete(path)
      folderObjects.delete(path)
    }),
    list: jest.fn(async (path: string) => ({
      files: [...text.keys()].filter(
        (item) =>
          item.startsWith(`${path}/`) &&
          !item.slice(path.length + 1).includes('/'),
      ),
      folders: [...folders].filter(
        (item) =>
          item.startsWith(`${path}/`) &&
          !item.slice(path.length + 1).includes('/'),
      ),
    })),
  }
  const create = jest.fn(async (path: string, content: string) => {
    if (path === failPath) throw new Error('injected write failure')
    text.set(path, content)
    const file = new (TFile as unknown as new () => { path: string })()
    file.path = path
    fileObjects.set(path, file)
    return file
  })
  const createBinary = jest.fn(async (path: string, bytes: ArrayBuffer) => {
    binary.set(path, bytes)
  })
  const createFolder = jest.fn(async (path: string) => {
    await adapter.mkdir(path)
  })
  const removePath = (path: string) => {
    text.delete(path)
    binary.delete(path)
    folders.delete(path)
    fileObjects.delete(path)
    folderObjects.delete(path)
  }
  const deleteFile = jest.fn(
    async (file: { path: string }, force?: boolean) => {
      if (force) {
        for (const path of [...text.keys(), ...binary.keys(), ...folders]) {
          if (path === file.path || path.startsWith(`${file.path}/`)) {
            removePath(path)
          }
        }
      }
      removePath(file.path)
    },
  )
  const app = {
    vault: {
      adapter,
      create,
      createBinary,
      createFolder,
      delete: deleteFile,
      getAbstractFileByPath: (path: string) =>
        folderObjects.get(path) ?? fileObjects.get(path) ?? null,
    },
  } as unknown as App
  return { app, adapter, text, binary, folders }
}

describe('Anki import transaction', () => {
  it('commits cards, media and SRS before removing its journal', async () => {
    const { app, text, binary } = createApp()
    const projectId = await commitAnkiImportPlan({
      app,
      plan: makePlan(),
      srsStore: createSrsStore(app),
    })
    expect(projectId).toBe('Learning/Deck')
    expect(text.get('Learning/Deck/index.md')).toContain('kind: cards')
    expect(text.get('Learning/Deck/Deck/cards.md')).toContain(
      '![[Learning/Deck/assets/hash.png]]',
    )
    expect(binary.has('Learning/Deck/assets/hash.png')).toBe(true)
    expect(text.has('YOLO/.yolo_json_db/learning-srs/Deck.json')).toBe(true)
    expect(
      [...text.keys()].some((path) => path.includes('anki-import-journals/')),
    ).toBe(false)
  })

  it('rolls back only journaled paths after a write failure', async () => {
    const { app, text, binary, folders } = createApp(
      'Learning/Deck/Deck/cards.md',
    )
    text.set('unrelated.md', 'keep')
    await expect(
      commitAnkiImportPlan({
        app,
        plan: makePlan(),
        srsStore: createSrsStore(app),
      }),
    ).rejects.toThrow('injected write failure')
    expect(text.get('unrelated.md')).toBe('keep')
    expect(
      [...text.keys()].some((path) => path.startsWith('Learning/Deck')),
    ).toBe(false)
    expect(
      [...binary.keys()].some((path) => path.startsWith('Learning/Deck')),
    ).toBe(false)
    expect(folders.has('Learning/Deck')).toBe(false)
  })

  it('recovers an interrupted transaction by exact journal cleanup', async () => {
    const { app, text, folders } = createApp()
    folders.add('Learning/Deck')
    text.set('Learning/Deck/partial.md', 'partial')
    text.set('unrelated.md', 'keep')
    folders.add('YOLO')
    folders.add('YOLO/.yolo_json_db')
    folders.add('YOLO/.yolo_json_db/anki-import-journals')
    text.set(
      'YOLO/.yolo_json_db/anki-import-journals/run.json',
      JSON.stringify({
        version: 1,
        runId: 'run',
        projectSlug: 'Deck',
        projectPath: 'Learning/Deck',
        indexPath: 'Learning/Deck/index.md',
        srsPath: 'YOLO/.yolo_json_db/learning-srs/Deck.json',
        createdFiles: ['Learning/Deck/partial.md'],
        createdFolders: ['Learning/Deck'],
      }),
    )
    await expect(
      recoverAnkiImports({ app, srsStore: createSrsStore(app) }),
    ).resolves.toEqual({
      confirmed: [],
      rolledBack: ['Learning/Deck'],
    })
    expect(text.get('unrelated.md')).toBe('keep')
    expect(text.has('Learning/Deck/partial.md')).toBe(false)
  })
})
