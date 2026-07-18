import React, { useEffect, useState } from 'react'

import type { LearningNavigationTarget } from './domain/runtime/learningNavigation'
import { createHostAnkiImportService } from './host/anki/import'
import { createHostLearningRuntimeAdapter } from './host/runtime'
import {
  type LearningSettingsModel,
  contributeLearningSettings,
  createLearningSettingsModel,
} from './host/settings'
import { resolveHostLearningSrsStore } from './host/srsStorage'
import { createLearningUiServices } from './host/ui'
import {
  type LearningLocale,
  LearningWorkspace,
  type LearningWorkspacePorts,
} from './ui/LearningWorkspace'
import type { OutlineBuilderWorkflow } from './ui/outline/OutlineBuilder'

const MODULE_ID = 'learning'
const VIEW_TYPE = 'yolo-learning-view'
const HOME_TARGET = Object.freeze({
  type: 'home',
}) satisfies LearningNavigationTarget

type RuntimeAdapter = ReturnType<typeof createHostLearningRuntimeAdapter>
type AnkiImportService = ReturnType<typeof createHostAnkiImportService>

type LearningMountAssembly = Readonly<{
  ownerDocument: Document
  ports: LearningWorkspacePorts
  navigate(target: LearningNavigationTarget): void
  dispose(): void
}>

export type LearningAssemblyRoot = Readonly<{
  attach(ownerElement: HTMLElement): LearningMountAssembly
  navigate(target: LearningNavigationTarget): void
  open(target?: LearningNavigationTarget): Promise<void>
  readStyle(): Promise<string>
  ready(): Promise<void>
  dispose(): void
}>

export function createLearningAssemblyRoot(
  host: YoloModuleHostApiV1,
): LearningAssemblyRoot {
  const backgroundOwner = document
  const srsStore = resolveHostLearningSrsStore(host)
  const ankiImport = createHostAnkiImportService(host, { srsStore })
  const settingsModelPromise = createLearningSettingsModel({
    config: host.config,
    settings: host.settings,
    onError: (error) =>
      reportError(host, 'Failed to update Learning settings', error),
  })
  const controllers = new Set<AbortController>()
  const mounts = new Set<LearningMountAssembly>()
  let pendingNavigation: LearningNavigationTarget | null = null
  let settingsModel: LearningSettingsModel | null = null
  let disposed = false

  void settingsModelPromise
    .then((model) => {
      if (disposed) model.dispose()
      else settingsModel = model
    })
    .catch(() => undefined)

  const openHome = (): void => {
    void open(HOME_TARGET).catch((error) =>
      reportError(host, 'Failed to open Learning mode', error),
    )
  }
  const runtimeAdapter = createHostLearningRuntimeAdapter({
    host,
    owner: backgroundOwner,
    openLearningHome: openHome,
    srsStore,
  })
  const runtime = runtimeAdapter.runtime
  const stats = runtime.getStatsService()
  runtime.startStats()
  const recoveryPromise = ankiImport
    .recover()
    .then(() => undefined)
    .catch((error) => {
      reportError(host, 'Failed to recover Anki imports', error)
    })

  const open = async (
    target: LearningNavigationTarget = HOME_TARGET,
  ): Promise<void> => {
    assertActive(disposed)
    const model = await settingsModelPromise
    assertActive(disposed)
    if (!(await acknowledgeBetaNotice(host, model))) return
    assertActive(disposed)
    pendingNavigation = target
    await host.workspace.openView({ state: { navigationTarget: target } })
    if (disposed) return
    if (pendingNavigation === target) flushNavigation(target)
  }

  const flushNavigation = (target?: LearningNavigationTarget): void => {
    if (target && pendingNavigation === target) pendingNavigation = null
    for (const mount of mounts) {
      mount.navigate(target ?? HOME_TARGET)
    }
  }

  const root: LearningAssemblyRoot = Object.freeze({
    attach: (ownerElement) => {
      assertActive(disposed)
      const ownerDocument = ownerElement.ownerDocument
      if (!ownerDocument?.defaultView) {
        throw new Error('Learning mount element has no owner window')
      }
      const mount = createMountAssembly({
        host,
        ownerDocument,
        runtimeAdapter,
        ankiImport,
        settingsModelPromise,
        stats,
        controllers,
        recoveryPromise,
        openProject: (projectId) =>
          open({
            type: 'project',
            projectId,
            tab: '卡片',
            cardMode: '浏览',
          }),
        onDispose: () => mounts.delete(mount),
      })
      mounts.add(mount)
      const pending = pendingNavigation
      if (pending) {
        mount.navigate(pending)
        pendingNavigation = null
      }
      return mount
    },
    navigate: (target) => {
      assertActive(disposed)
      pendingNavigation = target
      if (mounts.size > 0) flushNavigation(target)
    },
    open,
    readStyle: () => host.assets.readText('style.css'),
    ready: async () => {
      await Promise.all([settingsModelPromise, recoveryPromise])
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      pendingNavigation = null
      for (const controller of controllers) controller.abort()
      controllers.clear()
      for (const mount of [...mounts]) mount.dispose()
      mounts.clear()
      runtimeAdapter.dispose()
      settingsModel?.dispose()
    },
  })

  return root
}

function createMountAssembly({
  host,
  ownerDocument,
  runtimeAdapter,
  ankiImport,
  settingsModelPromise,
  stats,
  controllers,
  recoveryPromise,
  openProject,
  onDispose,
}: {
  host: YoloModuleHostApiV1
  ownerDocument: Document
  runtimeAdapter: RuntimeAdapter
  ankiImport: AnkiImportService
  settingsModelPromise: Promise<LearningSettingsModel>
  stats: ReturnType<RuntimeAdapter['runtime']['getStatsService']>
  controllers: Set<AbortController>
  recoveryPromise: Promise<void>
  openProject: (projectId: string) => Promise<void>
  onDispose: () => void
}): LearningMountAssembly {
  const runtime = runtimeAdapter.runtime
  let learningSettings: LearningSettingsModel | null = null
  let disposed = false
  void settingsModelPromise.then((model) => {
    if (!disposed) learningSettings = model
  })
  const ui = createLearningUiServices(host, {
    runtime,
    ownerDocument,
    generation: {
      onProjectReady: openProject,
    },
    getGenerationModelId: () =>
      learningSettings?.getSnapshot().modelId ??
      host.settings.getModelSnapshot().defaultModelId,
    reportError: (message, error) => reportError(host, message, error),
  })

  const ports = {
    ownerDocument,
    locale: resolveLocale(ownerDocument),
    t: (_key: string, fallback: string) => fallback,
    configuration: {
      getLearningBaseDir: () =>
        runtimeAdapter.settings.getSnapshot().learningBaseDir,
      subscribeLearningBaseDir: (listener: (baseDir: string) => void) =>
        runtimeAdapter.settings.subscribe((snapshot) =>
          listener(snapshot.learningBaseDir),
        ),
    },
    projects: {
      getSnapshot: () => stats.getSnapshot(),
      subscribe: (listener: Parameters<typeof stats.subscribe>[0]) =>
        stats.subscribe(listener),
      refresh: () => stats.refreshAll(),
    },
    projectActions: ui.homeProjectActions,
    projectEvents: {
      create: () => ui.eventBus,
    },
    navigation: createMountNavigation(),
    generation: {
      createWorkflow: (events) =>
        trackGenerationWorkflow(
          ui.createOutlineBuilderWorkflow(events),
          runtimeAdapter,
          controllers,
        ),
      abortAll: () => undefined,
    },
    recovery: {
      recoverAnkiImports: () => recoveryPromise,
    },
    wizardReferences: ui.wizardReferences,
    ankiImport,
    tabs: {
      outline: ui.outlineViewHost,
      cards: ui.cardsViewServices,
      exercises: ui.exercisesViewServices,
    },
    reportError: (message: string, error: unknown) =>
      reportError(host, message, error),
  } satisfies LearningWorkspacePorts

  const navigation = ports.navigation
  const mount = Object.freeze({
    ownerDocument,
    ports,
    navigate: (target: LearningNavigationTarget) => navigation.navigate(target),
    dispose: () => {
      if (disposed) return
      disposed = true
      ui.dispose()
      onDispose()
    },
  })
  return mount
}

function createMountNavigation(): LearningWorkspacePorts['navigation'] & {
  navigate(target: LearningNavigationTarget): void
} {
  let registration: symbol | null = null
  let handler: ((target: LearningNavigationTarget) => void) | null = null
  let pending: LearningNavigationTarget | null = null
  return {
    register: (nextHandler) => {
      const token = Symbol()
      registration = token
      handler = nextHandler
      if (pending) {
        const target = pending
        pending = null
        nextHandler(target)
      }
      return () => {
        if (registration !== token) return
        registration = null
        handler = null
      }
    },
    navigate: (target) => {
      if (handler) handler(target)
      else pending = target
    },
  }
}

function trackGenerationWorkflow(
  workflow: OutlineBuilderWorkflow,
  adapter: RuntimeAdapter,
  controllers: Set<AbortController>,
): OutlineBuilderWorkflow {
  const track = <T extends { signal: AbortSignal }, Result>(
    input: T,
    operation: (tracked: T) => Promise<Result>,
  ): Promise<Result> => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    input.signal.addEventListener('abort', abort, { once: true })
    if (input.signal.aborted) controller.abort()
    controllers.add(controller)
    adapter.runtime.trackGeneration(controller)
    return operation({ ...input, signal: controller.signal }).finally(() => {
      input.signal.removeEventListener('abort', abort)
      controllers.delete(controller)
      adapter.runtime.releaseGeneration(controller)
    })
  }
  return {
    generateOutline: (input) => track(input, workflow.generateOutline),
    generateProject: (input) => track(input, workflow.generateProject),
  }
}

function LearningModuleView({ root }: { root: LearningAssemblyRoot }) {
  const [ownerElement, setOwnerElement] = useState<HTMLDivElement | null>(null)
  const [mount, setMount] = useState<LearningMountAssembly | null>(null)
  const [styleText, setStyleText] = useState('')

  useEffect(() => {
    if (!ownerElement) return
    const nextMount = root.attach(ownerElement)
    setMount(nextMount)
    return () => {
      setMount(null)
      nextMount.dispose()
    }
  }, [ownerElement, root])

  useEffect(() => {
    let active = true
    void root
      .readStyle()
      .then((css) => {
        if (active) setStyleText(css)
      })
      .catch((error) => {
        if (active) console.error('Learning module style failed to load', error)
      })
    return () => {
      active = false
    }
  }, [root])

  return (
    <div className="yolo-learning-module-root" ref={setOwnerElement}>
      {styleText ? <style>{styleText}</style> : null}
      {mount ? <LearningWorkspace ports={mount.ports} /> : null}
    </div>
  )
}

function resolveLocale(ownerDocument: Document): LearningLocale {
  const language = ownerDocument.documentElement.lang.toLowerCase()
  if (language.startsWith('zh')) return 'zh'
  if (language.startsWith('it')) return 'it'
  return 'en'
}

async function acknowledgeBetaNotice(
  host: YoloModuleHostApiV1,
  model: LearningSettingsModel,
): Promise<boolean> {
  if (model.getSnapshot().betaNoticeAcknowledged) return true
  const confirmed = await host.ui.confirm({
    title: 'Learning mode public beta notice',
    message:
      'Learning mode is currently in public beta. Some features are still being refined and may be unstable or contain bugs. Some learning mode features will become part of paid plans in the future. Free users will still be able to use learning mode, but limits may apply to the number of learning projects they can create. Existing projects beyond the free allowance may become read-only, but they will not be deleted automatically.',
    ctaText: 'I understand, enter learning mode',
    cancelText: 'Not now',
  })
  if (!confirmed) return false
  await model.acknowledgeBetaNotice()
  return true
}

function assertActive(disposed: boolean): void {
  if (disposed) throw new Error('Learning assembly root is disposed')
}

function reportError(
  host: YoloModuleHostApiV1,
  message: string,
  error: unknown,
): void {
  console.error(`[YOLO] ${message}:`, error)
  host.ui.notice(
    `${message}: ${error instanceof Error ? error.message : String(error)}`,
  )
}

yolo.registerModule({
  id: MODULE_ID,
  activate(host) {
    contributeLearningSettings(host.settings)
    const deferredRoot = createDeferredLearningRoot(host)
    const root = deferredRoot.facade
    host.lifecycle.add(deferredRoot.dispose)
    getActiveLifecycle(host).whenActive(deferredRoot.initialize)
    const openHome = (): Promise<void> => root.open(HOME_TARGET)

    host.workspace.registerView({
      type: VIEW_TYPE,
      name: 'Learning mode',
      icon: 'graduation-cap',
      render: () => <LearningModuleView root={root} />,
      setState: async (state) => {
        const target = readNavigationTarget(state.navigationTarget)
        if (!target) return
        await root.ready()
        root.navigate(target)
      },
    })
    host.workspace.registerRibbonAction({
      icon: 'graduation-cap',
      title: 'Open learning mode',
      onClick: () => {
        void openHome().catch((error) =>
          reportError(host, 'Failed to open Learning mode', error),
        )
      },
    })
    host.workspace.registerCommand({
      id: 'open-learning-mode',
      name: 'Open learning mode',
      callback: openHome,
    })
  },
})

type ActiveLifecycle = YoloModuleHostApiV1['lifecycle'] &
  Readonly<{
    whenActive(callback: () => void | Promise<void>): void
  }>

function getActiveLifecycle(host: YoloModuleHostApiV1): ActiveLifecycle {
  return host.lifecycle as ActiveLifecycle
}

function createDeferredLearningRoot(host: YoloModuleHostApiV1): Readonly<{
  facade: LearningAssemblyRoot
  initialize(): Promise<void>
  dispose(): void
}> {
  let candidate: LearningAssemblyRoot | null = null
  let activeRoot: LearningAssemblyRoot | null = null
  let activationError: Error | null = null
  let initialization: Promise<void> | null = null
  let disposed = false

  const requireRoot = (): LearningAssemblyRoot => {
    if (disposed) throw new Error('Learning assembly root is disposed')
    if (activationError) throw activationError
    if (!activeRoot) throw new Error('Learning assembly root is not ready')
    return activeRoot
  }

  const facade: LearningAssemblyRoot = Object.freeze({
    attach: (ownerElement) => requireRoot().attach(ownerElement),
    navigate: (target) => requireRoot().navigate(target),
    open: async (target) => requireRoot().open(target),
    readStyle: async () => requireRoot().readStyle(),
    ready: async () => requireRoot().ready(),
    dispose: () => dispose(),
  })

  const initialize = (): Promise<void> => {
    if (initialization) return initialization
    initialization = (async () => {
      try {
        candidate = createLearningAssemblyRoot(host)
        await candidate.ready()
        if (disposed) throw new Error('Learning assembly root is disposed')
        activeRoot = candidate
      } catch (error) {
        candidate?.dispose()
        candidate = null
        activationError = toError(error)
        throw activationError
      }
    })()
    return initialization
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    candidate?.dispose()
    candidate = null
    activeRoot = null
  }

  return Object.freeze({ facade, initialize, dispose })
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function readNavigationTarget(value: unknown): LearningNavigationTarget | null {
  if (!value || typeof value !== 'object') return null
  const target = value as Record<string, unknown>
  if (target.type === 'home') return HOME_TARGET
  if (
    target.type !== 'project' ||
    typeof target.projectId !== 'string' ||
    target.tab !== '卡片' ||
    (target.cardMode !== '学习' && target.cardMode !== '浏览')
  ) {
    return null
  }
  return {
    type: 'project',
    projectId: target.projectId,
    tab: target.tab,
    cardMode: target.cardMode,
  }
}
