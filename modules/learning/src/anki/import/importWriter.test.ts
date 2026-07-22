import type { SrsProjectState } from '../../domain/srs/srsTypes'

import type { AnkiImportPlan } from './importPlan'
import { commitAnkiImportPlan, recoverAnkiImports } from './importWriter'
import type {
  AnkiImportJournalStorage,
  AnkiImportSrsPort,
  AnkiImportVaultPort,
} from './ports'

const plan = (): AnkiImportPlan => ({
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
      bytes: Uint8Array.from([1, 2]),
    },
    {
      sourceName: 'duplicate.png',
      fileName: 'hash.png',
      bytes: Uint8Array.from([1, 2]),
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

const fixture = (failPath?: string) => {
  const text = new Map<string, string>()
  const binary = new Map<string, ArrayBuffer>()
  const folders = new Set<string>()
  const removedFiles: string[] = []
  const removedFolders: string[] = []
  const vault: AnkiImportVaultPort = {
    exists: async (path) =>
      text.has(path) || binary.has(path) || folders.has(path),
    readText: async (path) =>
      text.get(path) ?? Promise.reject(new Error(`Missing: ${path}`)),
    readBinary: async (path) =>
      binary.get(path)?.slice(0) ??
      Promise.reject(new Error(`Missing: ${path}`)),
    ensureFolder: async (path) => void folders.add(path),
    createFolder: async (path) => {
      if (folders.has(path)) throw new Error(`Path already exists: ${path}`)
      folders.add(path)
    },
    createText: async (path, content) => {
      if (path === failPath) throw new Error('injected write failure')
      if (text.has(path)) throw new Error(`Path already exists: ${path}`)
      text.set(path, content)
    },
    createBinary: async (path, content) => {
      if (binary.has(path)) throw new Error(`Path already exists: ${path}`)
      binary.set(path, content.slice(0))
    },
    removeExactPath: async (path) => {
      removedFiles.push(path)
      text.delete(path)
      binary.delete(path)
    },
    removeEmptyFolder: async (path) => {
      const nonempty = [...text.keys(), ...binary.keys(), ...folders].some(
        (entry) => entry.startsWith(`${path}/`),
      )
      if (!nonempty) {
        removedFolders.push(path)
        folders.delete(path)
      }
    },
  }
  const journals = new Map<string, string>()
  const journalStorage: AnkiImportJournalStorage = {
    create: async (content) => {
      journals.set('journal/run.json', content)
      return 'journal/run.json'
    },
    write: async (path, content) => void journals.set(path, content),
    list: async () => [...journals.keys()],
    read: async (path) => journals.get(path)!,
    remove: async (path) => void journals.delete(path),
  }
  let active: SrsProjectState | null = null
  const persisted = new Map<string, SrsProjectState>()
  const deletedSrsPaths: string[] = []
  const srs: AnkiImportSrsPort = {
    getProjectStateFilePath: async () =>
      'Data/.yolo_json_db/learning-srs/Deck.json',
    initializeProjectStateAtPath: async (_slug, path, state) =>
      void persisted.set(path, structuredClone(state)),
    activateProjectState: (_slug, state) => {
      active = structuredClone(state)
    },
    invalidateProject: () => {
      active = null
    },
    getProjectState: async () =>
      active ?? Promise.reject(new Error('inactive SRS')),
    hasPersistedProjectStateAtPath: async (_slug, path) => persisted.has(path),
    deletePersistedProjectStateAtPath: async (_slug, path) => {
      deletedSrsPaths.push(path)
      persisted.delete(path)
      active = null
    },
  }
  const parser = {
    scanProject: jest.fn(async () => true),
    parseChapterCards: jest.fn(() => ({
      complete: true,
      cards: [{ cardUuid: 'aaaaaaaa' }],
    })),
  }
  return {
    vault,
    srs,
    parser,
    journalStorage,
    text,
    binary,
    folders,
    journals,
    persisted,
    removedFiles,
    removedFolders,
    deletedSrsPaths,
  }
}

describe('Anki import transaction', () => {
  it('commits hash-deduplicated media and SRS before the promotion index', async () => {
    const f = fixture()
    await expect(commitAnkiImportPlan({ plan: plan(), ...f })).resolves.toBe(
      'Learning/Deck',
    )
    expect(f.binary.size).toBe(1)
    expect(f.text.get('Learning/Deck/Deck/cards.md')).toContain(
      '![[Learning/Deck/assets/hash.png]]',
    )
    expect(f.persisted.has('Data/.yolo_json_db/learning-srs/Deck.json')).toBe(
      true,
    )
    expect(f.journals.size).toBe(0)
  })

  it('rolls back exact journal-owned paths without tree/trash deletion', async () => {
    const f = fixture('Learning/Deck/Deck/cards.md')
    f.text.set('Learning/Deck/foreign.md', 'keep')

    await expect(commitAnkiImportPlan({ plan: plan(), ...f })).rejects.toThrow(
      'injected write failure',
    )

    expect(f.text.get('Learning/Deck/foreign.md')).toBe('keep')
    expect(f.folders.has('Learning/Deck')).toBe(true)
    expect(f.removedFiles).not.toContain('Learning/Deck/foreign.md')
    expect(f.deletedSrsPaths).toEqual([
      'Data/.yolo_json_db/learning-srs/Deck.json',
    ])
  })

  it('removes pinned SRS state when final index promotion fails', async () => {
    const f = fixture('Learning/Deck/index.md')

    await expect(commitAnkiImportPlan({ plan: plan(), ...f })).rejects.toThrow(
      'injected write failure',
    )

    expect(f.persisted.size).toBe(0)
    expect(f.deletedSrsPaths).toEqual([
      'Data/.yolo_json_db/learning-srs/Deck.json',
    ])
    expect(f.journals.size).toBe(0)
  })

  it('recovers against the journal-pinned SRS path, not the current slug path', async () => {
    const f = fixture()
    const pinned = 'Old/.yolo_json_db/learning-srs/Deck.json'
    const current = 'Current/.yolo_json_db/learning-srs/Deck.json'
    f.persisted.set(current, plan().srsState)
    f.journals.set(
      'journal/run.json',
      JSON.stringify({
        version: 1,
        runId: 'run',
        projectSlug: 'Deck',
        projectPath: 'Learning/Deck',
        indexPath: 'Learning/Deck/index.md',
        srsPath: pinned,
        createdFiles: ['Learning/Deck/partial.md'],
        createdFolders: ['Learning/Deck'],
      }),
    )
    f.text.set('Learning/Deck/index.md', 'complete')
    f.text.set('Learning/Deck/partial.md', 'partial')

    await expect(recoverAnkiImports(f)).resolves.toEqual({
      confirmed: [],
      rolledBack: ['Learning/Deck'],
    })
    expect(f.persisted.has(current)).toBe(true)
    expect(f.deletedSrsPaths).toEqual([pinned])
    expect(f.text.has('Learning/Deck/partial.md')).toBe(false)
  })

  it('confirms a verified journal when promotion index and pinned SRS state exist', async () => {
    const f = fixture()
    const pinned = 'Old/.yolo_json_db/learning-srs/Deck.json'
    f.persisted.set(pinned, plan().srsState)
    f.text.set('Learning/Deck/index.md', 'complete')
    f.journals.set(
      'journal/run.json',
      JSON.stringify({
        version: 1,
        phase: 'verified',
        runId: 'run',
        projectSlug: 'Deck',
        projectPath: 'Learning/Deck',
        indexPath: 'Learning/Deck/index.md',
        srsPath: pinned,
        createdFiles: ['Learning/Deck/index.md'],
        createdFolders: ['Learning/Deck'],
      }),
    )

    await expect(recoverAnkiImports(f)).resolves.toEqual({
      confirmed: ['Learning/Deck'],
      rolledBack: [],
    })
    expect(f.text.has('Learning/Deck/index.md')).toBe(true)
    expect(f.persisted.has(pinned)).toBe(true)
    expect(f.journals.size).toBe(0)
  })

  it('rolls back an unverified crash with index and SRS when cards are damaged', async () => {
    const f = fixture()
    const importPlan = plan()
    const pinned = 'Old/.yolo_json_db/learning-srs/Deck.json'
    f.persisted.set(pinned, importPlan.srsState)
    f.folders.add('Learning/Deck')
    f.folders.add('Learning/Deck/Deck')
    f.text.set('Learning/Deck/index.md', 'complete')
    f.text.set('Learning/Deck/Deck/cards.md', 'damaged')
    f.journals.set(
      'journal/run.json',
      JSON.stringify({
        version: 1,
        phase: 'writing',
        runId: 'run',
        projectSlug: 'Deck',
        projectPath: 'Learning/Deck',
        indexPath: 'Learning/Deck/index.md',
        srsPath: pinned,
        createdFiles: ['Learning/Deck/Deck/cards.md', 'Learning/Deck/index.md'],
        createdFolders: ['Learning/Deck', 'Learning/Deck/Deck'],
      }),
    )

    await expect(recoverAnkiImports(f)).resolves.toEqual({
      confirmed: [],
      rolledBack: ['Learning/Deck'],
    })
    expect(f.text.has('Learning/Deck/Deck/cards.md')).toBe(false)
    expect(f.text.has('Learning/Deck/index.md')).toBe(false)
    expect(f.persisted.has(pinned)).toBe(false)
    expect(f.journals.size).toBe(0)
  })

  it('rolls back a legacy crash with index and SRS when media is missing', async () => {
    const f = fixture()
    const importPlan = plan()
    const pinned = 'Old/.yolo_json_db/learning-srs/Deck.json'
    f.persisted.set(pinned, importPlan.srsState)
    f.folders.add('Learning/Deck')
    f.folders.add('Learning/Deck/assets')
    f.text.set('Learning/Deck/index.md', 'complete')
    f.journals.set(
      'journal/run.json',
      JSON.stringify({
        version: 1,
        runId: 'legacy-run',
        projectSlug: 'Deck',
        projectPath: 'Learning/Deck',
        indexPath: 'Learning/Deck/index.md',
        srsPath: pinned,
        createdFiles: [
          'Learning/Deck/assets/hash.png',
          'Learning/Deck/index.md',
        ],
        createdFolders: ['Learning/Deck', 'Learning/Deck/assets'],
      }),
    )

    await expect(recoverAnkiImports(f)).resolves.toEqual({
      confirmed: [],
      rolledBack: ['Learning/Deck'],
    })
    expect(f.removedFiles).toContain('Learning/Deck/assets/hash.png')
    expect(f.persisted.has(pinned)).toBe(false)
    expect(f.journals.size).toBe(0)
  })
})
