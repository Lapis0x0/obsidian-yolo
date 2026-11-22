jest.mock('obsidian')

import { App, TFile } from 'obsidian'

import {
  readMemoryIndexes,
  resolveAssistantMemoryDirName,
  resolveMemoryDirPaths,
  resolveMemoryIndexPaths,
} from './memoryStore'

const createMockApp = (files: Record<string, string>): App => {
  const entries = new Map<string, TFile>()
  const contents = new Map<string, string>()
  Object.entries(files).forEach(([path, content]) => {
    entries.set(path, Object.assign(new TFile(), { path }))
    contents.set(path, content)
  })

  return {
    vault: {
      getAbstractFileByPath: jest.fn(
        (path: string) => entries.get(path) ?? null,
      ),
      read: jest.fn(async (file: TFile) => contents.get(file.path) ?? ''),
    },
  } as unknown as App
}

describe('resolveMemoryDirPaths', () => {
  it('resolves the directories that hold the fact files, not the indexes', () => {
    expect(
      resolveMemoryDirPaths({
        settings: {
          yolo: { baseDir: 'Vault/Brain' },
          assistants: [{ id: 'a1', name: 'Writer' }],
        },
        assistantId: 'a1',
      }),
    ).toEqual({
      global: 'Vault/Brain/memory/global',
      assistant: 'Vault/Brain/memory/Writer',
      project: null,
    })
  })

  it('has no assistant directory when no assistant is found', () => {
    expect(
      resolveMemoryDirPaths({
        settings: { assistants: [{ id: 'a1', name: 'Writer' }] },
        assistantId: 'missing',
      }),
    ).toEqual({ global: 'YOLO/memory/global', assistant: null, project: null })
  })

  it('stays in step with the index paths', () => {
    const args = {
      settings: { assistants: [{ id: 'a1', name: 'Writer' }] },
      assistantId: 'a1',
    }
    const dirs = resolveMemoryDirPaths(args)
    const indexes = resolveMemoryIndexPaths(args)
    expect(indexes.global).toBe(`${dirs.global}/MEMORY.md`)
    expect(indexes.assistant).toBe(`${dirs.assistant}/MEMORY.md`)
  })
})

describe('project memory', () => {
  const settings = {
    assistants: [{ id: 'a1', name: 'Writer' }],
    projects: [
      { id: 'p2', name: 'Thesis' },
      { id: 'p1', name: 'Thesis' },
      { id: 'p3', name: 'Re/search' },
    ],
  }

  it('lives under projects/ and only exists inside a project', () => {
    expect(
      resolveMemoryDirPaths({ settings, assistantId: 'a1', projectId: 'p3' }),
    ).toEqual({
      global: 'YOLO/memory/global',
      assistant: 'YOLO/memory/Writer',
      project: 'YOLO/memory/projects/Re_search',
    })
    expect(resolveMemoryDirPaths({ settings, assistantId: 'a1' }).project).toBe(
      null,
    )
    expect(
      resolveMemoryDirPaths({ settings, projectId: 'deleted' }).project,
    ).toBe(null)
  })

  it('suffixes same-named projects by id order', () => {
    expect(resolveMemoryDirPaths({ settings, projectId: 'p1' }).project).toBe(
      'YOLO/memory/projects/Thesis',
    )
    expect(resolveMemoryDirPaths({ settings, projectId: 'p2' }).project).toBe(
      'YOLO/memory/projects/Thesis (2)',
    )
  })

  it('reads the project index alongside the others', async () => {
    const app = createMockApp({
      'YOLO/memory/global/MEMORY.md': 'global',
      'YOLO/memory/projects/Re_search/MEMORY.md': 'project',
    })
    expect(
      await readMemoryIndexes({
        app,
        settings,
        assistantId: 'a1',
        projectId: 'p3',
      }),
    ).toEqual({ global: 'global', assistant: null, project: 'project' })
  })

  it('keeps an assistant named "projects" out of the projects tree', () => {
    expect(
      resolveAssistantMemoryDirName({
        settings: undefined,
        assistant: { id: 'a9', name: 'Projects' },
      }),
    ).toBe('projects (assistant)')
  })
})

describe('resolveMemoryIndexPaths', () => {
  it('resolves both indexes under the configured base directory', () => {
    const settings = {
      currentAssistantId: 'a1',
      assistants: [{ id: 'a1', name: 'Writer' }],
    }

    expect(resolveMemoryIndexPaths({ settings, assistantId: 'a1' })).toEqual({
      global: 'YOLO/memory/global/MEMORY.md',
      assistant: 'YOLO/memory/Writer/MEMORY.md',
      project: null,
    })
  })

  it('follows a changed base directory instead of a cached one', () => {
    const assistants = [{ id: 'a1', name: 'Writer' }]

    expect(
      resolveMemoryIndexPaths({
        settings: { yolo: { baseDir: 'Vault/Brain' }, assistants },
        assistantId: 'a1',
      }),
    ).toEqual({
      global: 'Vault/Brain/memory/global/MEMORY.md',
      assistant: 'Vault/Brain/memory/Writer/MEMORY.md',
      project: null,
    })

    expect(
      resolveMemoryIndexPaths({
        settings: { yolo: { baseDir: 'Other' }, assistants },
        assistantId: 'a1',
      }).assistant,
    ).toBe('Other/memory/Writer/MEMORY.md')
  })

  it('returns paths for files that do not exist yet', () => {
    // The watcher has to watch a MEMORY.md that is about to be created, and
    // the rules text names both paths before either file exists.
    const paths = resolveMemoryIndexPaths({
      settings: { assistants: [{ id: 'a1', name: 'Writer' }] },
      assistantId: 'a1',
    })
    expect(paths.global).toBe('YOLO/memory/global/MEMORY.md')
    expect(paths.assistant).toBe('YOLO/memory/Writer/MEMORY.md')
  })

  it('resolves the assistant index for an assistant without a system prompt', () => {
    // v1 gated assistant memory on the assistant having instructions; v2 does
    // not — the directory existing is the only condition.
    expect(
      resolveMemoryIndexPaths({
        settings: { assistants: [{ id: 'a1', name: 'Bare' }] },
        assistantId: 'a1',
      }).assistant,
    ).toBe('YOLO/memory/Bare/MEMORY.md')
  })

  it('has no assistant index when no assistant is passed or found', () => {
    expect(
      resolveMemoryIndexPaths({
        settings: {
          currentAssistantId: 'a1',
          assistants: [{ id: 'a1', name: 'Writer' }],
        },
      }).assistant,
    ).toBeNull()

    expect(
      resolveMemoryIndexPaths({
        settings: { assistants: [{ id: 'a1', name: 'Writer' }] },
        assistantId: 'missing',
      }).assistant,
    ).toBeNull()
  })
})

describe('resolveAssistantMemoryDirName', () => {
  it('sanitizes path-hostile characters and falls back to the id', () => {
    expect(
      resolveAssistantMemoryDirName({
        settings: undefined,
        assistant: { id: 'a1', name: 'Re/search:  bot' },
      }),
    ).toBe('Re_search_ bot')

    expect(
      resolveAssistantMemoryDirName({
        settings: undefined,
        assistant: { id: 'assistant-7', name: '   ' },
      }),
    ).toBe('assistant-7')
  })

  it('suffixes same-named assistants so each keeps its own directory', () => {
    const settings = {
      assistants: [
        { id: 'a1', name: 'Writer' },
        { id: 'a2', name: 'Writer' },
        { id: 'a3', name: 'Writer' },
      ],
    }

    expect(
      settings.assistants.map((assistant) =>
        resolveAssistantMemoryDirName({ settings, assistant }),
      ),
    ).toEqual(['Writer', 'Writer (2)', 'Writer (3)'])
  })

  it('keeps an assistant out of the reserved `global` directory', () => {
    expect(
      resolveAssistantMemoryDirName({
        settings: undefined,
        assistant: { id: 'a1', name: 'global' },
      }),
    ).toBe('global (assistant)')

    // Case-insensitive: the reserved name is a directory, not a literal.
    expect(
      resolveAssistantMemoryDirName({
        settings: undefined,
        assistant: { id: 'a1', name: 'Global' },
      }),
    ).toBe('global (assistant)')
  })

  it('deduplicates assistants that all collide with the reserved name', () => {
    const settings = {
      assistants: [
        { id: 'a1', name: 'global' },
        { id: 'a2', name: 'GLOBAL' },
      ],
    }

    expect(
      settings.assistants.map((assistant) =>
        resolveAssistantMemoryDirName({ settings, assistant }),
      ),
    ).toEqual(['global (assistant)', 'global (assistant) (2)'])
  })
})

describe('readMemoryIndexes', () => {
  const settings = {
    assistants: [{ id: 'a1', name: 'Writer' }],
  }

  it('reads both indexes in full', async () => {
    const app = createMockApp({
      'YOLO/memory/global/MEMORY.md': '- [A](a.md) — when A\n',
      'YOLO/memory/Writer/MEMORY.md': '- [B](b.md) — when B\n',
    })

    expect(
      await readMemoryIndexes({ app, settings, assistantId: 'a1' }),
    ).toEqual({
      global: '- [A](a.md) — when A',
      assistant: '- [B](b.md) — when B',
      project: null,
    })
  })

  it('treats a missing file as absent', async () => {
    const app = createMockApp({})
    expect(
      await readMemoryIndexes({ app, settings, assistantId: 'a1' }),
    ).toEqual({ global: null, assistant: null, project: null })
  })

  it('treats a whitespace-only file as absent', async () => {
    const app = createMockApp({
      'YOLO/memory/global/MEMORY.md': '   \n\n',
      'YOLO/memory/Writer/MEMORY.md': 'kept',
    })
    expect(
      await readMemoryIndexes({ app, settings, assistantId: 'a1' }),
    ).toEqual({ global: null, assistant: 'kept', project: null })
  })

  it('reads only global when one side is missing', async () => {
    const app = createMockApp({
      'YOLO/memory/global/MEMORY.md': 'global only',
    })
    expect(
      await readMemoryIndexes({ app, settings, assistantId: 'a1' }),
    ).toEqual({ global: 'global only', assistant: null, project: null })
  })

  it('never reads an assistant index when no assistant is passed', async () => {
    const app = createMockApp({
      'YOLO/memory/global/MEMORY.md': 'global',
      'YOLO/memory/Writer/MEMORY.md': 'assistant',
    })
    // Module chat modes run with no assistant; the store must not fall back to
    // settings.currentAssistantId and leak that assistant's memory back in.
    expect(
      await readMemoryIndexes({
        app,
        settings: { ...settings, currentAssistantId: 'a1' },
      }),
    ).toEqual({ global: 'global', assistant: null, project: null })
  })
})
