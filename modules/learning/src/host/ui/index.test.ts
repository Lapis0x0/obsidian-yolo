import { generateCardsParallel } from '../../generation/cardGenerator'
import type {
  CardGenerationEvent,
  CardGenerationResult,
} from '../../generation/types'

import { createLearningUiServices } from './index'

jest.mock('../../generation/cardGenerator', () => ({
  ...jest.requireActual('../../generation/cardGenerator'),
  generateCardsParallel: jest.fn(),
}))

const generateCardsParallelMock = jest.mocked(generateCardsParallel)

type VaultEntry = ReturnType<YoloModuleHostApiV1['vault']['getEntry']>
type HostTextSnapshot = NonNullable<
  Awaited<ReturnType<YoloModuleHostApiV1['vault']['readTextSnapshot']>>
>

class MemoryLearningHost {
  contentRoot = 'First/learning'
  agentText = JSON.stringify({
    projectName: 'Memory project',
    projectGoal: 'Test adapters',
    chapters: [{ title: 'One', contract: 'Learn one' }],
    estimatedKnowledgePoints: 2,
  })
  readonly notices: string[] = []
  readonly opened: YoloModuleHostOpenFileLocationV1[] = []
  readonly trashed: string[] = []
  readonly actionToasts: YoloModuleHostActionToastV1[] = []
  readonly agentRequests: Array<{
    activity?: { title: string; detail?: string }
  }> = []
  confirmResult = true
  private readonly entries = new Map<string, NonNullable<VaultEntry>>()
  private readonly text = new Map<string, string>()
  private readonly snapshots = new Map<string, HostTextSnapshot>()

  readonly api = {
    paths: {
      getSnapshot: () => ({ contentRoot: this.contentRoot }),
      subscribe: () => () => undefined,
    },
    settings: {
      getModelSnapshot: () => ({ defaultModelId: 'memory-model', models: [] }),
    },
    agent: {
      stream: (request: { activity?: { title: string; detail?: string } }) => {
        this.agentRequests.push(request)
        return this.streamAgent()
      },
    },
    ui: {
      notice: (message: string) => this.notices.push(message),
      showActionToast: (toast: YoloModuleHostActionToastV1) => {
        this.actionToasts.push(toast)
      },
      confirm: async () => this.confirmResult,
      createMarkdownRenderer: () => ({
        render: async () => undefined,
        unload: () => undefined,
      }),
      htmlToMarkdown: (html: string) => `md:${html}`,
      isModEvent: () => true,
      openLink: async () => undefined,
      openFileAt: async (location: YoloModuleHostOpenFileLocationV1) => {
        this.opened.push(location)
        return true
      },
      hoverLink: () => undefined,
    },
    vault: {
      getEntry: (path: string) => this.entries.get(path) ?? null,
      listChildren: (folderPath: string) =>
        [...this.entries.values()].filter(
          (entry) => parentPath(entry.path) === folderPath,
        ),
      listMarkdownFiles: () =>
        [...this.entries.values()].filter(
          (entry) => entry.kind === 'file' && entry.name.endsWith('.md'),
        ),
      exists: async (path: string) => this.entries.has(path),
      readText: async (path: string) => {
        const content = this.text.get(path)
        if (content == null) throw new Error(`Missing text: ${path}`)
        return content
      },
      readBinary: async () => new ArrayBuffer(0),
      ensureFolder: async (path: string) => this.addFolderTree(path),
      createFolder: async (path: string) => this.addFolderTree(path),
      createText: async (path: string, content: string) => {
        this.addText(path, content)
        return { path, mtime: 1 }
      },
      createBinary: async (path: string) => this.addFile(path),
      writeText: async (path: string, content: string) => {
        this.addText(path, content)
        return { path, mtime: 2 }
      },
      renamePath: async (oldPath: string, newPath: string) => {
        const entry = this.entries.get(oldPath)
        if (!entry) throw new Error(`Missing path: ${oldPath}`)
        this.entries.delete(oldPath)
        this.entries.set(newPath, {
          ...entry,
          path: newPath,
          name: leaf(newPath),
        })
        const content = this.text.get(oldPath)
        if (content != null) {
          this.text.delete(oldPath)
          this.text.set(newPath, content)
        }
      },
      trashPath: async (path: string) => {
        if (!this.entries.has(path)) return false
        this.trashed.push(path)
        for (const candidate of [...this.entries.keys()]) {
          if (candidate === path || candidate.startsWith(`${path}/`)) {
            this.entries.delete(candidate)
            this.text.delete(candidate)
            this.snapshots.delete(candidate)
          }
        }
        return true
      },
      removeFileExact: async (path: string) => this.removeExact(path, 'file'),
      removeEmptyFolderExact: async (path: string) =>
        this.removeExact(path, 'folder'),
      readTextSnapshot: async (path: string) => {
        if (!this.text.has(path)) return null
        return this.currentSnapshot(path)
      },
      createTextIfAbsent: async (path: string, content: string) => {
        if (this.entries.has(path)) return null
        this.addText(path, content)
        return this.currentSnapshot(path)
      },
      replaceTextIfUnchanged: async (
        expected: HostTextSnapshot,
        content: string,
      ) => {
        if (this.snapshots.get(expected.path) !== expected) return null
        this.addText(expected.path, content)
        return this.currentSnapshot(expected.path)
      },
      revertOwnedCreatedTextIfUnchanged: async (
        _created: HostTextSnapshot,
        expected: HostTextSnapshot,
        fallbackContent: string,
      ) => {
        if (this.snapshots.get(expected.path) !== expected) return null
        this.addText(expected.path, fallbackContent)
        return this.currentSnapshot(expected.path)
      },
      subscribe: () => () => undefined,
    },
  } as unknown as YoloModuleHostApiV1

  addProject(root: string, slug: string): void {
    this.addFolderTree(`${root}/${slug}`)
    this.addText(
      `${root}/${slug}/index.md`,
      `---\ntopic: ${slug}\ngoal: Test ${slug}\nstatus: studying\nchapters: []\n---\n`,
    )
  }

  addText(path: string, content: string): void {
    this.addFolderTree(parentPath(path))
    this.addFile(path)
    this.text.set(path, content)
    this.snapshots.set(path, Object.freeze({ path, content }))
  }

  private addFile(path: string): void {
    this.entries.set(path, {
      kind: 'file',
      path,
      name: leaf(path),
      ctime: 1,
      mtime: 1,
    })
  }

  private addFolderTree(path: string): void {
    const parts = path.split('/')
    for (let index = 1; index <= parts.length; index += 1) {
      const folderPath = parts.slice(0, index).join('/')
      this.entries.set(folderPath, {
        kind: 'folder',
        path: folderPath,
        name: parts[index - 1],
      })
    }
  }

  private currentSnapshot(path: string): HostTextSnapshot {
    const snapshot = this.snapshots.get(path)
    if (!snapshot) throw new Error(`Missing snapshot: ${path}`)
    return snapshot
  }

  private removeExact(path: string, kind: 'file' | 'folder'): boolean {
    const entry = this.entries.get(path)
    if (entry?.kind !== kind) return false
    if (
      kind === 'folder' &&
      [...this.entries.keys()].some(
        (candidate) => parentPath(candidate) === path,
      )
    ) {
      return false
    }
    this.entries.delete(path)
    this.text.delete(path)
    this.snapshots.delete(path)
    return true
  }

  private async *streamAgent() {
    yield { type: 'text' as const, text: this.agentText, delta: this.agentText }
    yield { type: 'completed' as const, text: this.agentText }
  }
}

function createRuntime() {
  let eventBus: unknown = null
  const srs = {
    pauseProject: jest.fn(async () => undefined),
    resumeProject: jest.fn(async () => undefined),
    isProjectPaused: jest.fn(async () => false),
    deleteProjectState: jest.fn(async () => undefined),
  }
  return {
    srs,
    runtime: {
      getSrsStore: () => srs,
      getEventBus: () => eventBus,
      setEventBus: (next: unknown) => {
        eventBus = next
      },
    },
  }
}

describe('createLearningUiServices memory host', () => {
  beforeEach(() => {
    generateCardsParallelMock.mockReset()
  })

  it('resolves the managed root dynamically for scans and staging', async () => {
    const memory = new MemoryLearningHost()
    memory.addProject('First/learning', 'alpha')
    memory.addProject('Second/learning', 'beta')
    const { runtime } = createRuntime()
    const services = createLearningUiServices(memory.api, {
      runtime: runtime as never,
      ownerDocument: {} as Document,
      generation: { generateCards: false },
    })

    await expect(services.scanProjects()).resolves.toMatchObject({
      projects: [{ slug: 'alpha' }],
    })
    memory.contentRoot = 'Second/learning'
    await expect(services.scanProjects()).resolves.toMatchObject({
      projects: [{ slug: 'beta' }],
    })
    await expect(
      services.wizardReferences.createStagingDir('stale/learning'),
    ).resolves.toMatch(/^Second\/learning\/_staging\//)

    services.dispose()
  })

  it('adapts card CAS writes, open-file, confirmation, and project trash', async () => {
    const memory = new MemoryLearningHost()
    memory.addProject('First/learning', 'alpha')
    const { runtime, srs } = createRuntime()
    const services = createLearningUiServices(memory.api, {
      runtime: runtime as never,
      ownerDocument: {} as Document,
      generation: { generateCards: false },
    })
    const cardsPath = 'First/learning/alpha/chapter/cards.md'
    const card = await services.cardsViewServices.cardFiles.createCard(
      'First/learning/alpha',
      cardsPath,
      'Chapter',
      '1234abcd',
      { front: 'front', back: 'back' },
    )
    expect(card.kpUuid).toBe('1234abcd')
    expect(await memory.api.vault.readText(cardsPath)).toContain('<!--card:')

    services.outlineViewHost.openMarkdownAtLine(cardsPath, 7)
    await Promise.resolve()
    expect(memory.opened).toEqual([{ path: cardsPath, line: 7 }])

    const project = (await services.scanProjects()).projects[0]
    const confirmed = jest.fn()
    services.homeProjectActions.confirmDelete(project, confirmed)
    await Promise.resolve()
    await Promise.resolve()
    expect(confirmed).toHaveBeenCalledTimes(1)
    await expect(
      services.homeProjectActions.deleteProject(project),
    ).resolves.toBe('deleted')
    expect(memory.trashed).toContain('First/learning/alpha')
    expect(srs.pauseProject).toHaveBeenCalledWith('alpha', expect.any(Date))
    expect(srs.deleteProjectState).toHaveBeenCalledWith('alpha')
  })

  it('forwards streamed outline snapshots through the UI workflow', async () => {
    const memory = new MemoryLearningHost()
    const { runtime } = createRuntime()
    const services = createLearningUiServices(memory.api, {
      runtime: runtime as never,
      ownerDocument: {} as Document,
      generation: { generateCards: false },
    })
    const onOutline = jest.fn()
    const onProgress = jest.fn()
    const outline = await services.outlineBuilderWorkflow.generateOutline({
      topic: 'Adapters',
      level: 'familiar',
      goal: 'Ship',
      signal: new AbortController().signal,
      onOutline,
      onProgress,
    })

    expect(outline.projectName).toBe('Memory project')
    expect(onOutline).toHaveBeenCalled()
    expect(onProgress).toHaveBeenCalled()
    expect(memory.agentRequests[0]?.activity).toEqual({
      title: '正在生成学习项目大纲',
      detail: 'Adapters',
    })
  })

  it('writes a project from the knowledge generation stream', async () => {
    const memory = new MemoryLearningHost()
    memory.agentText = '## Point one\n\nA durable explanation.'
    const { runtime } = createRuntime()
    const services = createLearningUiServices(memory.api, {
      runtime: runtime as never,
      ownerDocument: {} as Document,
      generation: { generateCards: false },
    })
    const onProjectStarted = jest.fn(async (_projectPath: string) => undefined)
    const onChapterProgress = jest.fn()
    const onComplete = jest.fn()

    await services.outlineBuilderWorkflow.generateProject({
      topic: 'Generated',
      level: 'familiar',
      goal: 'Understand it',
      projectName: 'Generated',
      projectGoal: 'Understand it',
      chapters: [{ title: 'Chapter one', contract: 'Explain point one' }],
      signal: new AbortController().signal,
      onProjectStarted,
      onChapterProgress,
      onComplete,
    })

    const projectPath = onProjectStarted.mock.calls[0][0]
    expect(projectPath).toMatch(/^First\/learning\/Generated/)
    expect(onComplete).toHaveBeenCalledWith(projectPath)
    expect(onChapterProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'completed' }),
    )
    expect(
      await memory.api.vault.readText(`${projectPath}/index.md`),
    ).toContain('status: studying')
    const knowledge = memory.api.vault
      .listMarkdownFiles()
      .find(
        (file) =>
          file.path.startsWith(projectPath) && file.name === 'knowledge.md',
      )
    expect(knowledge).toBeDefined()
    await expect(
      memory.api.vault.readText(knowledge?.path ?? ''),
    ).resolves.toContain('## Point one <!--kp:')
    expect(memory.agentRequests[0]?.activity).toEqual({
      title: '正在生成学习项目',
      detail: 'Chapter one',
    })
  })

  it('streams card events in order and opens the successful project for study', async () => {
    const memory = new MemoryLearningHost()
    memory.agentText = '## Point one\n\nA durable explanation.'
    const { runtime } = createRuntime()
    const openProjectCards = jest.fn(async () => undefined)
    const sequence: string[] = []
    const events = {
      onCardGenerationStarted: jest.fn((runId: string, projectId: string) => {
        sequence.push(`started:${runId}:${projectId}`)
      }),
      onCard: jest.fn((event: CardGenerationEvent) => {
        sequence.push(`card:${event.runId}:${event.projectId}`)
      }),
      onChapterSettled: jest.fn(
        (runId: string, projectId: string, _result: CardGenerationResult) => {
          sequence.push(`settled:${runId}:${projectId}`)
        },
      ),
      onCardGenerationFinished: jest.fn(
        (runId: string, projectId: string, failed: boolean) => {
          sequence.push(`finished:${runId}:${projectId}:${String(failed)}`)
        },
      ),
    }
    generateCardsParallelMock.mockImplementation(async (options) => {
      const event = cardEvent(options.runId ?? '', options.projectId ?? '')
      const result = cardResult('generated', [event.card])
      options.onCard?.(event)
      options.onChapterSettled?.(result)
      return [result]
    })
    const services = createLearningUiServices(memory.api, {
      runtime: runtime as never,
      ownerDocument: {} as Document,
      generation: { openProjectCards },
    })

    await services
      .createOutlineBuilderWorkflow(events)
      .generateProject(projectGenerationInput())

    const [runId, projectId] = events.onCardGenerationStarted.mock.calls[0]
    expect(sequence).toEqual([
      `started:${runId}:${projectId}`,
      `card:${runId}:${projectId}`,
      `settled:${runId}:${projectId}`,
      `finished:${runId}:${projectId}:false`,
    ])
    expect(generateCardsParallelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId,
        projectId,
        activity: expect.objectContaining({
          title: '正在生成学习卡片',
          detail: 'Generated',
        }),
      }),
    )
    expect(memory.actionToasts).toHaveLength(1)
    expect(memory.actionToasts[0]).toMatchObject({
      tone: 'success',
      actionLabel: '开始学习',
    })
    await memory.actionToasts[0].onAction()
    expect(openProjectCards).toHaveBeenCalledWith(projectId, '学习')
  })

  it('reports partial card generation and targets browsing', async () => {
    const memory = new MemoryLearningHost()
    memory.agentText = '## Point one\n\nA durable explanation.'
    const { runtime } = createRuntime()
    const openProjectCards = jest.fn()
    const onCardGenerationFinished = jest.fn()
    generateCardsParallelMock.mockImplementation(async (options) => {
      const result = cardResult('partial', [
        cardEvent(options.runId ?? '', options.projectId ?? '').card,
      ])
      options.onChapterSettled?.(result)
      return [result]
    })
    const services = createLearningUiServices(memory.api, {
      runtime: runtime as never,
      ownerDocument: {} as Document,
      generation: { openProjectCards },
    })

    await services
      .createOutlineBuilderWorkflow({
        onCardGenerationStarted: jest.fn(),
        onCard: jest.fn(),
        onChapterSettled: jest.fn(),
        onCardGenerationFinished,
      })
      .generateProject(projectGenerationInput())

    expect(onCardGenerationFinished).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      true,
    )
    expect(memory.actionToasts[0]).toMatchObject({
      tone: 'warning',
      actionLabel: '浏览卡片',
    })
    await memory.actionToasts[0].onAction()
    expect(openProjectCards).toHaveBeenCalledWith(
      onCardGenerationFinished.mock.calls[0][1],
      '浏览',
    )
  })

  it('reports a completed failed result as an error toast', async () => {
    const memory = new MemoryLearningHost()
    memory.agentText = '## Point one\n\nA durable explanation.'
    const { runtime } = createRuntime()
    const openProjectCards = jest.fn()
    generateCardsParallelMock.mockResolvedValue([cardResult('failed')])
    const services = createLearningUiServices(memory.api, {
      runtime: runtime as never,
      ownerDocument: {} as Document,
      generation: { openProjectCards },
    })

    await services
      .createOutlineBuilderWorkflow()
      .generateProject(projectGenerationInput())

    expect(memory.actionToasts[0]).toMatchObject({
      tone: 'error',
      actionLabel: '浏览卡片',
    })
    await memory.actionToasts[0].onAction()
    expect(openProjectCards).toHaveBeenCalledWith(
      expect.stringMatching(/^First\/learning\/Generated/),
      '浏览',
    )
  })

  it('finishes an aborted card run as failed without showing a toast', async () => {
    const memory = new MemoryLearningHost()
    memory.agentText = '## Point one\n\nA durable explanation.'
    const { runtime } = createRuntime()
    const controller = new AbortController()
    const onCardGenerationFinished = jest.fn()
    generateCardsParallelMock.mockImplementation(async (options) => {
      const result = cardResult('failed')
      options.onChapterSettled?.(result)
      controller.abort()
      return [result]
    })
    const services = createLearningUiServices(memory.api, {
      runtime: runtime as never,
      ownerDocument: {} as Document,
    })

    await expect(
      services
        .createOutlineBuilderWorkflow({
          onCardGenerationStarted: jest.fn(),
          onCard: jest.fn(),
          onChapterSettled: jest.fn(),
          onCardGenerationFinished,
        })
        .generateProject(projectGenerationInput(controller.signal)),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(onCardGenerationFinished).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      true,
    )
    expect(memory.actionToasts).toEqual([])
  })

  it('generates cards without listeners through the compatibility workflow', async () => {
    const memory = new MemoryLearningHost()
    memory.agentText = '## Point one\n\nA durable explanation.'
    const { runtime } = createRuntime()
    generateCardsParallelMock.mockResolvedValue([cardResult('generated')])
    const services = createLearningUiServices(memory.api, {
      runtime: runtime as never,
      ownerDocument: {} as Document,
    })

    await expect(
      services.outlineBuilderWorkflow.generateProject(projectGenerationInput()),
    ).resolves.toBeUndefined()
    expect(memory.actionToasts).toHaveLength(1)
  })
})

function projectGenerationInput(signal = new AbortController().signal) {
  return {
    topic: 'Generated',
    level: 'familiar',
    goal: 'Understand it',
    projectName: 'Generated',
    projectGoal: 'Understand it',
    chapters: [{ title: 'Chapter one', contract: 'Explain point one' }],
    signal,
    onProjectStarted: jest.fn(async () => undefined),
    onChapterProgress: jest.fn(),
    onComplete: jest.fn(),
  }
}

function cardEvent(runId: string, projectId: string): CardGenerationEvent {
  return {
    runId,
    projectId,
    chapterId: 'chapter-1',
    chapterIndex: 0,
    cardIndex: 0,
    cardUuid: 'card0001',
    card: {
      title: 'Point one',
      kpUuid: '1234abcd',
      front: 'Question',
      back: 'Answer',
      startLine: 1,
      cardUuid: 'card0001',
    },
  }
}

function cardResult(
  status: CardGenerationResult['status'],
  cards: CardGenerationResult['cards'] = [],
): CardGenerationResult {
  return {
    chapterIndex: 0,
    chapterTitle: 'Chapter one',
    cards,
    status,
    discardedCount: status === 'partial' ? 1 : 0,
    ...(status === 'failed' ? { error: 'Failed' } : {}),
  }
}

function leaf(path: string): string {
  return path.split('/').at(-1) ?? path
}

function parentPath(path: string): string {
  return path.split('/').slice(0, -1).join('/')
}
