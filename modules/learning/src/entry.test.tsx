import type { ReactElement } from 'react'

import type { LearningNavigationTarget } from './domain/runtime/learningNavigation'
import type {
  LearningWorkspaceGenerationEvents,
  LearningWorkspacePorts,
} from './ui/LearningWorkspace'
import type { OutlineBuilderWorkflow } from './ui/outline/OutlineBuilder'

const mockSrsStore = { canonical: true }
const mockSettingsModel = {
  getSnapshot: jest.fn(() => ({
    modelId: 'learning-model',
    betaNoticeAcknowledged: true,
  })),
  subscribe: jest.fn(() => jest.fn()),
  setModelId: jest.fn(async () => undefined),
  acknowledgeBetaNotice: jest.fn(async () => undefined),
  dispose: jest.fn(),
}
const mockRecoverAnkiImports = jest.fn(async () => undefined)
const mockResolveSrsStore = jest.fn(() => mockSrsStore)
const mockCreateAnkiImport = jest.fn(() => ({
  prepare: jest.fn(),
  commit: jest.fn(),
  listExistingProjectSlugs: jest.fn(() => []),
  recover: mockRecoverAnkiImports,
  runtime: {},
}))
const mockCreateSettingsModel = jest.fn(async () => mockSettingsModel)
const mockContributeSettings = jest.fn()
const mockRuntimeAdapters: Array<ReturnType<typeof createRuntimeAdapter>> = []
const mockUiServices: Array<ReturnType<typeof createUiServices>> = []
const mockOutline = {
  projectName: 'Project',
  projectGoal: 'Learn',
  chapters: [],
  estimatedKnowledgePoints: 0,
}

jest.mock('./host/srsStorage', () => ({
  resolveHostLearningSrsStore: mockResolveSrsStore,
}))
jest.mock('./host/anki/import', () => ({
  createHostAnkiImportService: mockCreateAnkiImport,
}))
jest.mock('./host/settings', () => ({
  contributeLearningSettings: mockContributeSettings,
  createLearningSettingsModel: mockCreateSettingsModel,
}))
jest.mock('./host/runtime', () => ({
  createHostLearningRuntimeAdapter: jest.fn((options) => {
    const adapter = createRuntimeAdapter(options)
    mockRuntimeAdapters.push(adapter)
    return adapter
  }),
}))
jest.mock('./host/ui', () => ({
  createLearningUiServices: jest.fn((_host, options) => {
    const services = createUiServices(options)
    mockUiServices.push(services)
    return services
  }),
}))
jest.mock('./ui/LearningWorkspace', () => ({
  LearningWorkspace: () => null,
}))

function createRuntimeAdapter(options: { owner: Document; srsStore: unknown }) {
  let navigationHandler: ((target: LearningNavigationTarget) => void) | null =
    null
  let pending: LearningNavigationTarget | null = null
  const snapshot = {
    projects: [],
    byProject: new Map(),
    pausedProjectIds: new Set(),
    failedProjectIds: new Set(),
    loading: false,
  }
  const stats = {
    getSnapshot: jest.fn(() => snapshot),
    subscribe: jest.fn(() => jest.fn()),
    refreshAll: jest.fn(async () => snapshot),
  }
  const runtime = {
    getStatsService: jest.fn(() => stats),
    startStats: jest.fn(),
    setEventBus: jest.fn(),
    setNavigationHandler: jest.fn((handler: typeof navigationHandler) => {
      navigationHandler = handler
      if (handler && pending) {
        const target = pending
        pending = null
        handler(target)
      }
    }),
    queueNavigation: jest.fn((target: LearningNavigationTarget) => {
      pending = target
    }),
    flushNavigation: jest.fn(() => {
      if (navigationHandler && pending) {
        const target = pending
        pending = null
        navigationHandler(target)
      }
    }),
    trackGeneration: jest.fn(),
    releaseGeneration: jest.fn(),
  }
  return {
    options,
    runtime,
    settings: {
      getSnapshot: () => ({ learningBaseDir: 'YOLO/learning' }),
      subscribe: jest.fn(() => jest.fn()),
    },
    dispose: jest.fn(),
  }
}

function createUiServices(options: {
  ownerDocument: Document
  generation?: { onProjectReady?(projectPath: string): void | Promise<void> }
}) {
  const eventBus = { dispose: jest.fn() }
  const createOutlineBuilderWorkflow = jest.fn(
    (_events: LearningWorkspaceGenerationEvents): OutlineBuilderWorkflow => ({
      generateOutline: jest.fn(async () => mockOutline),
      generateProject: jest.fn(async () => undefined),
    }),
  )
  return {
    options,
    ownerDocument: options.ownerDocument,
    homeProjectActions: {},
    wizardReferences: {},
    createOutlineBuilderWorkflow,
    outlineViewHost: {},
    cardsViewServices: {},
    exercisesViewServices: {},
    eventBus,
    scanProjects: jest.fn(),
    scanProject: jest.fn(),
    getLearningBaseDir: () => 'YOLO/learning',
    dispose: jest.fn(() => eventBus.dispose()),
  }
}

type RegisteredModule = {
  id: string
  activate(host: YoloModuleHostApiV1): void | Promise<void>
}

type RegisteredView = Parameters<
  YoloModuleHostApiV1['workspace']['registerView']
>[0]
type RegisteredCommand = Parameters<
  YoloModuleHostApiV1['workspace']['registerCommand']
>[0]

function createHost() {
  const lifecycleDisposers: Array<() => void> = []
  const activeCallbacks: Array<() => void | Promise<void>> = []
  const registerRibbonAction = jest.fn()
  const registerCommand = jest.fn((next: RegisteredCommand) => {
    command = next
  })
  const openView = jest.fn(async () => undefined)
  const notice = jest.fn()
  let active = false
  let command: RegisteredCommand | null = null
  let view: RegisteredView | null = null
  const requireActive = <Result,>(operation: () => Result): Result => {
    if (!active) throw new Error('Capability is unavailable during declaration')
    return operation()
  }
  const host = {
    lifecycle: {
      add: (dispose: () => void) => lifecycleDisposers.push(dispose),
      onQuiesce: jest.fn(),
      whenActive: (callback: () => void | Promise<void>) => {
        activeCallbacks.push(callback)
      },
    },
    workspace: {
      registerView: (next: RegisteredView) => {
        view = next
      },
      registerRibbonAction,
      registerCommand,
      openView: (...args: Parameters<typeof openView>) =>
        requireActive(() => openView(...args)),
    },
    assets: {
      readText: jest.fn(async () =>
        requireActive(() => Promise.resolve('.learning {}')),
      ),
    },
    config: {},
    i18n: {
      getSnapshot: () => ({ locale: 'en' }),
      subscribe: jest.fn(() => jest.fn()),
    },
    settings: {
      contribute: jest.fn(),
      getModelSnapshot: () =>
        requireActive(() => ({
          defaultModelId: 'default-model',
          models: [],
        })),
    },
    ui: {
      confirm: jest.fn(async () => true),
      notice,
    },
  } as unknown as YoloModuleHostApiV1
  return {
    host,
    lifecycleDisposers,
    registerCommand,
    registerRibbonAction,
    openView,
    notice,
    getCommand: () => command,
    getView: () => view,
    runWhenActive: async () => {
      active = true
      await Promise.all(
        activeCallbacks.map((callback) => Promise.resolve(callback())),
      )
    },
  }
}

function ownerDocument(language = 'zh-CN'): Document {
  return {
    defaultView: {},
    documentElement: { lang: language },
  } as unknown as Document
}

describe('production Learning module entry', () => {
  let definition: RegisteredModule
  let mainDocument: Document

  beforeAll(async () => {
    Object.defineProperty(globalThis, 'yolo', {
      configurable: true,
      value: {
        registerModule: (registered: RegisteredModule) => {
          definition = registered
        },
      },
    })
    await import('./index')
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockRuntimeAdapters.length = 0
    mockUiServices.length = 0
    mainDocument = ownerDocument('en-US')
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: mainDocument,
    })
  })

  afterAll(() => {
    Reflect.deleteProperty(globalThis, 'yolo')
    Reflect.deleteProperty(globalThis, 'document')
  })

  it('registers the production view identity, ribbon, command, and settings', async () => {
    const harness = createHost()

    await definition.activate(harness.host)

    expect(definition.id).toBe('learning')
    expect(mockContributeSettings).toHaveBeenCalledWith(harness.host.settings)
    expect(harness.getView()).toEqual(
      expect.objectContaining({
        type: 'yolo-learning-view',
        name: expect.objectContaining({
          en: 'Learning mode',
          zh: '学习模式',
          it: 'Modalità apprendimento',
        }),
        icon: 'graduation-cap',
      }),
    )
    expect(harness.registerRibbonAction).toHaveBeenCalledTimes(1)
    expect(harness.registerCommand).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'open-learning-mode' }),
    )
    expect(mockResolveSrsStore).not.toHaveBeenCalled()
  })

  it('assembles once post-active and starts recovery without opening a view', async () => {
    const harness = createHost()
    await definition.activate(harness.host)
    expect(mockRuntimeAdapters).toHaveLength(0)

    await harness.runWhenActive()
    await harness.runWhenActive()

    expect(mockResolveSrsStore).toHaveBeenCalledTimes(1)
    expect(mockCreateAnkiImport).toHaveBeenCalledWith(harness.host, {
      srsStore: mockSrsStore,
    })
    expect(mockCreateAnkiImport).toHaveBeenCalledTimes(1)
    expect(mockRecoverAnkiImports).toHaveBeenCalledTimes(1)
    expect(mockRuntimeAdapters).toHaveLength(1)
    expect(mockRuntimeAdapters[0].options).toEqual(
      expect.objectContaining({ owner: mainDocument, srsStore: mockSrsStore }),
    )
    expect(mockRuntimeAdapters[0].runtime.startStats).toHaveBeenCalledTimes(1)
    expect(mockUiServices).toHaveLength(0)
    expect(harness.registerRibbonAction).toHaveBeenCalledTimes(1)
    expect(harness.registerCommand).toHaveBeenCalledTimes(1)
  })

  it('rejects facade calls before readiness and after post-active failure', async () => {
    const activationError = new Error('settings failed')
    mockCreateSettingsModel.mockRejectedValueOnce(activationError)
    const harness = createHost()
    await definition.activate(harness.host)
    const root = getRoot(harness.getView())
    const command = harness.getCommand()
    const view = harness.getView()
    if (!command || !view) throw new Error('Learning contributions missing')
    const target = {
      type: 'project',
      projectId: 'failed-project',
      tab: '卡片',
      cardMode: '浏览',
    } as const

    await expect(root.open()).rejects.toThrow('not ready')
    await expect(command.callback()).rejects.toThrow('not ready')
    await expect(view.setState?.({ navigationTarget: target })).rejects.toThrow(
      'not ready',
    )
    expect(() =>
      root.attach({ ownerDocument: ownerDocument() } as HTMLElement),
    ).toThrow('not ready')
    await expect(harness.runWhenActive()).rejects.toBe(activationError)
    await expect(root.open()).rejects.toBe(activationError)
    await expect(command.callback()).rejects.toBe(activationError)
    await expect(view.setState?.({ navigationTarget: target })).rejects.toBe(
      activationError,
    )
    expect(() =>
      root.attach({ ownerDocument: ownerDocument() } as HTMLElement),
    ).toThrow(activationError)
    expect(mockRuntimeAdapters[0].dispose).toHaveBeenCalledTimes(1)
  })

  it('routes targeted view state to the mounted workspace', async () => {
    const harness = createHost()
    await definition.activate(harness.host)
    await harness.runWhenActive()
    const view = harness.getView()
    if (!view) throw new Error('Learning view was not registered')
    const node = view.render() as ReactElement<{
      root: {
        attach(element: HTMLElement): unknown
      }
    }>
    const document = ownerDocument()
    const mount = node.props.root.attach({
      ownerDocument: document,
    } as HTMLElement) as {
      ports: LearningWorkspacePorts
    }
    const staleNavigate = jest.fn()
    const unregisterStale = mount.ports.navigation.register(staleNavigate)
    const navigate = jest.fn()
    mount.ports.navigation.register(navigate)
    unregisterStale()
    const target = {
      type: 'project',
      projectId: 'project-one',
      tab: '卡片',
      cardMode: '学习',
    } as const

    await view.setState?.({ navigationTarget: target })

    expect(navigate).toHaveBeenCalledWith(target)
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(staleNavigate).not.toHaveBeenCalled()
    expect(
      mockRuntimeAdapters[0].runtime.queueNavigation,
    ).not.toHaveBeenCalled()
  })

  it.each([
    ['main then popout', 0, 1],
    ['popout then main', 1, 0],
  ] as const)(
    'isolates two workspace mounts when closing %s',
    async (_label, firstClosed, remaining) => {
      const harness = createHost()
      await definition.activate(harness.host)
      await harness.runWhenActive()
      const root = getRoot(harness.getView())
      const mounts = [
        root.attach({ ownerDocument: ownerDocument('en-US') } as HTMLElement),
        root.attach({ ownerDocument: ownerDocument('zh-CN') } as HTMLElement),
      ]
      const projectState: Array<string | null> = [null, null]
      const navigationCalls = [jest.fn(), jest.fn()]
      const unregister = mounts.map((mount, index) =>
        mount.ports.navigation.register((target) => {
          navigationCalls[index](target)
          projectState[index] =
            target.type === 'project' ? target.projectId : null
        }),
      )
      const initialTargets = [
        {
          type: 'project',
          projectId: 'main-project',
          tab: '卡片',
          cardMode: '浏览',
        },
        {
          type: 'project',
          projectId: 'popout-project',
          tab: '卡片',
          cardMode: '学习',
        },
      ] as const

      mounts[0].navigate(initialTargets[0])
      mounts[1].navigate(initialTargets[1])
      expect(projectState).toEqual(['main-project', 'popout-project'])
      expect(mockUiServices[0].eventBus).not.toBe(mockUiServices[1].eventBus)

      unregister[firstClosed]()
      mounts[firstClosed].dispose()
      const targeted = {
        type: 'project',
        projectId: 'targeted-project',
        tab: '卡片',
        cardMode: '浏览',
      } as const
      root.navigate(targeted)

      expect(navigationCalls[firstClosed]).toHaveBeenCalledTimes(1)
      expect(navigationCalls[remaining]).toHaveBeenLastCalledWith(targeted)
      expect(navigationCalls[remaining]).toHaveBeenCalledTimes(2)
      expect(projectState[firstClosed]).toBe(
        initialTargets[firstClosed].projectId,
      )
      expect(projectState[remaining]).toBe('targeted-project')
      expect(mockUiServices[firstClosed].dispose).toHaveBeenCalledTimes(1)
      expect(mockUiServices[remaining].dispose).not.toHaveBeenCalled()

      unregister[remaining]()
      mounts[remaining].dispose()
    },
  )

  it('shares one runtime across mounts while creating ownerDocument UI services', async () => {
    const harness = createHost()
    await definition.activate(harness.host)
    await harness.runWhenActive()
    const view = harness.getView()
    if (!view) throw new Error('Learning view was not registered')
    const node = view.render() as ReactElement<{
      root: {
        attach(element: HTMLElement): { dispose(): void }
      }
    }>
    const firstDocument = ownerDocument('it-IT')
    const secondDocument = ownerDocument('zh-CN')

    node.props.root.attach({
      ownerDocument: firstDocument,
    } as HTMLElement)
    node.props.root.attach({
      ownerDocument: secondDocument,
    } as HTMLElement)

    expect(mockRuntimeAdapters).toHaveLength(1)
    expect(mockUiServices).toHaveLength(2)
    expect(mockUiServices[0].options.ownerDocument).toBe(firstDocument)
    expect(mockUiServices[1].options.ownerDocument).toBe(secondDocument)
  })

  it('binds generation events and keeps generation alive across mount disposal', async () => {
    const harness = createHost()
    await definition.activate(harness.host)
    await harness.runWhenActive()
    const root = getRoot(harness.getView())
    const mount = root.attach({
      ownerDocument: ownerDocument(),
    } as HTMLElement)
    const events = {
      onCardGenerationStarted: jest.fn(),
      onCard: jest.fn(),
      onChapterSettled: jest.fn(),
      onCardGenerationFinished: jest.fn(),
    }
    let generationSignal: AbortSignal | undefined
    mockUiServices[0].createOutlineBuilderWorkflow.mockReturnValue({
      generateOutline: jest.fn(async (input) => {
        generationSignal = input.signal
        return mockOutline
      }),
      generateProject: jest.fn(async () => undefined),
    })
    const workflow = mount.ports.generation.createWorkflow(events)
    const pending = workflow.generateOutline(createOutlineInput())

    expect(mockUiServices[0].createOutlineBuilderWorkflow).toHaveBeenCalledWith(
      events,
    )
    mount.dispose()
    expect(generationSignal?.aborted).toBe(false)
    expect(mockRuntimeAdapters[0].dispose).not.toHaveBeenCalled()
    await pending
  })

  it('aborts generation and disposes all activation resources at root disposal', async () => {
    const harness = createHost()
    await definition.activate(harness.host)
    await harness.runWhenActive()
    const root = getRoot(harness.getView())
    const mount = root.attach({
      ownerDocument: ownerDocument(),
    } as HTMLElement)
    let generationSignal: AbortSignal | undefined
    mockUiServices[0].createOutlineBuilderWorkflow.mockReturnValue({
      generateOutline: jest.fn(async (input) => {
        generationSignal = input.signal
        return mockOutline
      }),
      generateProject: jest.fn(async () => undefined),
    })
    const workflow = mount.ports.generation.createWorkflow({
      onCardGenerationStarted: jest.fn(),
      onCard: jest.fn(),
      onChapterSettled: jest.fn(),
      onCardGenerationFinished: jest.fn(),
    })
    const pending = workflow.generateOutline(createOutlineInput())

    harness.lifecycleDisposers[0]()
    expect(generationSignal?.aborted).toBe(true)
    expect(mockUiServices[0].dispose).toHaveBeenCalledTimes(1)
    expect(mockRuntimeAdapters[0].dispose).toHaveBeenCalledTimes(1)
    expect(mockSettingsModel.dispose).toHaveBeenCalledTimes(1)
    await pending
  })

  it('isolates recovery failure and reuses its settled promise for workspaces', async () => {
    const recoveryError = new Error('broken journal')
    mockRecoverAnkiImports.mockRejectedValueOnce(recoveryError)
    const consoleError = jest.spyOn(console, 'error').mockImplementation()
    const harness = createHost()

    expect(definition.activate(harness.host)).toBeUndefined()
    await expect(harness.runWhenActive()).resolves.toBeUndefined()
    const root = getRoot(harness.getView())
    const mount = root.attach({
      ownerDocument: ownerDocument(),
    } as HTMLElement)
    await expect(
      mount.ports.recovery.recoverAnkiImports(),
    ).resolves.toBeUndefined()
    await expect(
      mount.ports.recovery.recoverAnkiImports(),
    ).resolves.toBeUndefined()

    expect(mockRecoverAnkiImports).toHaveBeenCalledTimes(1)
    expect(harness.notice).toHaveBeenCalledWith(
      expect.stringContaining('Learning action failed'),
    )
    expect(harness.getView()).not.toBeNull()
    consoleError.mockRestore()
  })

  it('opens a generated project through the activation root', async () => {
    const harness = createHost()
    await definition.activate(harness.host)
    await harness.runWhenActive()
    const root = getRoot(harness.getView())
    root.attach({ ownerDocument: ownerDocument() } as HTMLElement)

    await mockUiServices[0].options.generation?.onProjectReady?.(
      'Learning/project-one',
    )

    expect(harness.openView).toHaveBeenCalledWith({
      state: {
        navigationTarget: {
          type: 'project',
          projectId: 'Learning/project-one',
          tab: '卡片',
          cardMode: '浏览',
        },
      },
    })
  })
})

function getRoot(view: RegisteredView | null) {
  if (!view) throw new Error('Learning view was not registered')
  const node = view.render() as ReactElement<{
    root: {
      open(target?: LearningNavigationTarget): Promise<void>
      navigate(target: LearningNavigationTarget): void
      attach(element: HTMLElement): {
        ports: {
          generation: LearningWorkspacePorts['generation']
          navigation: LearningWorkspacePorts['navigation']
          recovery: LearningWorkspacePorts['recovery']
        }
        navigate(target: LearningNavigationTarget): void
        dispose(): void
      }
    }
  }>
  return node.props.root
}

function createOutlineInput() {
  return {
    topic: 'Topic',
    level: 'Beginner',
    goal: 'Learn',
    signal: new AbortController().signal,
    onOutline: jest.fn(),
    onProgress: jest.fn(),
  }
}
