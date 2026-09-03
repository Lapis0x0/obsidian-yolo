import type {
  BackgroundActivity,
  BackgroundActivityBatchSink,
} from '../background/backgroundActivityRegistry'

import type { ModuleLifecycleScope } from './lifecycleScope'
import {
  type ModuleAgentCapabilityProviderV1,
  UNAVAILABLE_MODULE_AGENT_CAPABILITY_PROVIDER,
} from './moduleAgent'
import {
  type ModuleAssetsCapabilityProviderV1,
  UNAVAILABLE_MODULE_ASSETS_CAPABILITY_PROVIDER,
} from './moduleAssets'
import {
  MAX_MODULE_CHAT_MODES_PER_MODULE,
  type ModuleChatModeContributionSinkV1,
  snapshotModuleChatMode,
} from './moduleChatModeRegistry'
import type {
  ModuleConfigCapabilityActivationV1,
  ModuleConfigV1,
} from './moduleConfig'
import {
  type ModuleFileTextRendererContributionSinkV1,
  snapshotModuleFileTextRenderer,
} from './moduleFileTextRendererRegistry'
import {
  ModuleI18nCapabilityProvider,
  type ModuleI18nCapabilityProviderV1,
} from './moduleI18n'
import {
  type ModulePathsCapabilityProviderV1,
  UNAVAILABLE_MODULE_PATHS_CAPABILITY_PROVIDER,
} from './modulePaths'
import type {
  ModulePrivateStorageCapabilityProviderV1,
  ModulePrivateStorageScopeV1,
  ModulePrivateStorageV1,
} from './modulePrivateStorage'
import {
  type ModuleSettingsCapabilityProviderV1,
  UNAVAILABLE_MODULE_SETTINGS_CAPABILITY_PROVIDER,
} from './moduleSettingsContributions'
import { assertModuleId } from './moduleStore'
import {
  MAX_MODULE_TOOL_SETS_PER_MODULE,
  type ModuleToolSetContributionSinkV1,
  snapshotModuleToolSet,
} from './moduleToolSetRegistry'
import {
  type ModuleUiCapabilityProviderV1,
  UNAVAILABLE_MODULE_UI_CAPABILITY_PROVIDER,
} from './moduleUi'
import {
  type ModuleVaultCapabilityProviderV1,
  UNAVAILABLE_MODULE_VAULT_CAPABILITY_PROVIDER,
} from './moduleVault'
import { ModuleWorkerHostCapabilityProvider } from './moduleWorkerHost'
import type {
  YoloModuleBackgroundActivityV1,
  YoloModuleBackgroundV1,
  YoloModuleCapabilitiesV1,
  YoloModuleChatModeV1,
  YoloModuleChatV1,
  YoloModuleFileTextRendererV1,
  YoloModuleToolSetV1,
} from './types'

export type ModuleHostCapabilityProviderV1 = {
  create(
    moduleId: string,
    lifecycle: ModuleLifecycleScope,
  ): ModuleHostCapabilityActivationV1
}

export type ModuleHostCapabilityActivationV1 = Readonly<{
  capabilities: YoloModuleCapabilitiesV1
  prepare(): Promise<void>
  commit(): void
  activate(): void
}>

export type ModuleConfigCapabilityProviderV1 = {
  create(
    moduleId: string,
    lifecycle: ModuleLifecycleScope,
  ): ModuleConfigCapabilityActivationV1
}

const unavailableConfigApi: ModuleConfigV1 = Object.freeze({
  getSnapshot: () => {
    throw new Error('Module config capability is unavailable')
  },
  replace: async () => {
    throw new Error('Module config capability is unavailable')
  },
  subscribe: () => {
    throw new Error('Module config capability is unavailable')
  },
})

export const UNAVAILABLE_MODULE_CONFIG_CAPABILITY_PROVIDER: ModuleConfigCapabilityProviderV1 =
  Object.freeze({
    create: () => ({
      api: unavailableConfigApi,
      activate: async () => undefined,
    }),
  })

const unavailablePrivateStorageScope: ModulePrivateStorageScopeV1 =
  Object.freeze({
    list: async () => {
      throw new Error('Module private storage capability is unavailable')
    },
    stat: async () => {
      throw new Error('Module private storage capability is unavailable')
    },
    listEntries: async () => {
      throw new Error('Module private storage capability is unavailable')
    },
    readText: async () => {
      throw new Error('Module private storage capability is unavailable')
    },
    readBinary: async () => {
      throw new Error('Module private storage capability is unavailable')
    },
    readJson: async () => {
      throw new Error('Module private storage capability is unavailable')
    },
    writeText: async () => {
      throw new Error('Module private storage capability is unavailable')
    },
    writeBinary: async () => {
      throw new Error('Module private storage capability is unavailable')
    },
    writeJson: async () => {
      throw new Error('Module private storage capability is unavailable')
    },
    mkdir: async () => {
      throw new Error('Module private storage capability is unavailable')
    },
    rename: async () => {
      throw new Error('Module private storage capability is unavailable')
    },
    removeFile: async () => {
      throw new Error('Module private storage capability is unavailable')
    },
    remove: async () => {
      throw new Error('Module private storage capability is unavailable')
    },
  })

const unavailablePrivateStorageApi: ModulePrivateStorageV1 = Object.freeze({
  synchronized: unavailablePrivateStorageScope,
  deviceLocal: unavailablePrivateStorageScope,
})

export const UNAVAILABLE_MODULE_PRIVATE_STORAGE_CAPABILITY_PROVIDER: ModulePrivateStorageCapabilityProviderV1 =
  Object.freeze({
    create: () => ({
      api: unavailablePrivateStorageApi,
      activate: () => undefined,
    }),
  })

class ModuleBackgroundCleanupError extends Error {
  constructor(readonly errors: unknown[]) {
    super('Module background cleanup reported errors')
    this.name = 'ModuleBackgroundCleanupError'
  }
}

type CoreModuleHostCapabilityProviderOptions = {
  agent?: ModuleAgentCapabilityProviderV1
  assets?: ModuleAssetsCapabilityProviderV1
  backgroundActivities: BackgroundActivityBatchSink
  chat?: ModuleChatCapabilityProviderV1
  config?: ModuleConfigCapabilityProviderV1
  i18n?: ModuleI18nCapabilityProviderV1
  paths?: ModulePathsCapabilityProviderV1
  privateStorage?: ModulePrivateStorageCapabilityProviderV1
  settings?: ModuleSettingsCapabilityProviderV1
  ui?: ModuleUiCapabilityProviderV1
  vault?: ModuleVaultCapabilityProviderV1
  workers?: Pick<ModuleWorkerHostCapabilityProvider, 'create'>
  now?: () => number
  reportCallbackError?: (moduleId: string, error: unknown) => void
}

export class CoreModuleHostCapabilityProvider
  implements ModuleHostCapabilityProviderV1
{
  private readonly agent: ModuleAgentCapabilityProviderV1
  private readonly assets: ModuleAssetsCapabilityProviderV1
  private readonly backgroundActivities: BackgroundActivityBatchSink
  private readonly chat: ModuleChatCapabilityProviderV1
  private readonly config: ModuleConfigCapabilityProviderV1
  private readonly now: () => number
  private readonly i18n: ModuleI18nCapabilityProviderV1
  private readonly paths: ModulePathsCapabilityProviderV1
  private readonly privateStorage: ModulePrivateStorageCapabilityProviderV1
  private readonly settings: ModuleSettingsCapabilityProviderV1
  private readonly ui: ModuleUiCapabilityProviderV1
  private readonly reportCallbackError: (
    moduleId: string,
    error: unknown,
  ) => void
  private readonly vault: ModuleVaultCapabilityProviderV1
  private readonly workers: Pick<ModuleWorkerHostCapabilityProvider, 'create'>

  constructor({
    agent = UNAVAILABLE_MODULE_AGENT_CAPABILITY_PROVIDER,
    assets = UNAVAILABLE_MODULE_ASSETS_CAPABILITY_PROVIDER,
    backgroundActivities,
    chat = UNAVAILABLE_MODULE_CHAT_CAPABILITY_PROVIDER,
    config = UNAVAILABLE_MODULE_CONFIG_CAPABILITY_PROVIDER,
    i18n = new ModuleI18nCapabilityProvider(),
    paths = UNAVAILABLE_MODULE_PATHS_CAPABILITY_PROVIDER,
    privateStorage = UNAVAILABLE_MODULE_PRIVATE_STORAGE_CAPABILITY_PROVIDER,
    settings = UNAVAILABLE_MODULE_SETTINGS_CAPABILITY_PROVIDER,
    ui = UNAVAILABLE_MODULE_UI_CAPABILITY_PROVIDER,
    vault = UNAVAILABLE_MODULE_VAULT_CAPABILITY_PROVIDER,
    workers = new ModuleWorkerHostCapabilityProvider(),
    now = Date.now,
    reportCallbackError = (moduleId, error) => {
      console.error(
        `[YOLO] Module "${moduleId}" background callback failed`,
        error,
      )
    },
  }: CoreModuleHostCapabilityProviderOptions) {
    this.agent = agent
    this.assets = assets
    this.backgroundActivities = backgroundActivities
    this.chat = chat
    this.config = config
    this.i18n = i18n
    this.paths = paths
    this.privateStorage = privateStorage
    this.settings = settings
    this.ui = ui
    this.vault = vault
    this.workers = workers
    this.now = now
    this.reportCallbackError = reportCallbackError
  }

  create(
    moduleId: string,
    lifecycle: ModuleLifecycleScope,
  ): ModuleHostCapabilityActivationV1 {
    const agent = this.agent.create(moduleId, lifecycle)
    const assets = this.assets.create(moduleId, lifecycle)
    const background = createModuleBackgroundCapability({
      moduleId,
      lifecycle,
      sink: this.backgroundActivities,
      now: this.now,
      reportCallbackError: this.reportCallbackError,
    })
    const chat = this.chat.create(moduleId, lifecycle)
    const config = this.config.create(moduleId, lifecycle)
    const i18n = this.i18n.create(moduleId, lifecycle)
    const paths = this.paths.create(moduleId, lifecycle)
    const privateStorage = this.privateStorage.create(moduleId, lifecycle)
    const settings = this.settings.create(moduleId, lifecycle)
    const ui = this.ui.create(moduleId, lifecycle)
    const vault = this.vault.create(moduleId, lifecycle)
    const workers = this.workers.create(moduleId, lifecycle)
    return Object.freeze({
      capabilities: Object.freeze({
        agent: agent.api,
        assets: assets.api,
        background: background.api,
        chat: chat.api,
        config: config.api,
        i18n: i18n.api,
        paths: paths.api,
        privateStorage: privateStorage.api,
        settings: settings.api,
        ui: ui.api,
        vault: vault.api,
        workers: workers.api,
      }),
      prepare: () => config.activate(),
      commit: () => {
        settings.commit()
        background.commit()
        chat.commit()
      },
      activate: () => {
        agent.activate()
        assets.activate()
        background.activate()
        chat.activate()
        paths.activate()
        privateStorage.activate()
        settings.activate()
        ui.activate()
        vault.activate()
        workers.activate()
      },
    })
  }
}

export type ModuleChatCapabilityProviderV1 = Readonly<{
  create(
    moduleId: string,
    lifecycle: ModuleLifecycleScope,
  ): Readonly<{
    api: YoloModuleChatV1
    commit(): void
    activate(): void
  }>
}>

export type ModuleChatCapabilityProviderOptions = Readonly<{
  sink: ModuleChatModeContributionSinkV1
  toolSetSink: ModuleToolSetContributionSinkV1
  fileTextRendererSink: ModuleFileTextRendererContributionSinkV1
}>

export class CoreModuleChatCapabilityProvider
  implements ModuleChatCapabilityProviderV1
{
  constructor(private readonly options: ModuleChatCapabilityProviderOptions) {}

  create(moduleId: string, lifecycle: ModuleLifecycleScope) {
    return createModuleChatCapability({
      moduleId,
      lifecycle,
      sink: this.options.sink,
      toolSetSink: this.options.toolSetSink,
      fileTextRendererSink: this.options.fileTextRendererSink,
    })
  }
}

export const UNAVAILABLE_MODULE_CHAT_CAPABILITY_PROVIDER: ModuleChatCapabilityProviderV1 =
  Object.freeze({
    create: () => ({
      api: Object.freeze({
        registerMode: () => {
          throw new Error('Module chat capability is unavailable')
        },
        registerToolSet: () => {
          throw new Error('Module chat capability is unavailable')
        },
        registerFileTextRenderer: () => {
          throw new Error('Module chat capability is unavailable')
        },
      }),
      commit: () => undefined,
      activate: () => undefined,
    }),
  })

/**
 * Stages a module's chat mode declarations during `activate()` and
 * publishes them to the shared `ModuleChatModeRegistry` atomically on
 * `commit()` — mirrors `ModuleSettingsCapabilityProvider`'s staged/commit
 * shape. The lifecycle disposer revokes every published mode (module
 * disable/uninstall, or a rollback after a failed activation).
 */
function createModuleChatCapability({
  moduleId,
  lifecycle,
  sink,
  toolSetSink,
  fileTextRendererSink,
}: {
  moduleId: string
  lifecycle: ModuleLifecycleScope
  sink: ModuleChatModeContributionSinkV1
  toolSetSink: ModuleToolSetContributionSinkV1
  fileTextRendererSink: ModuleFileTextRendererContributionSinkV1
}): {
  api: YoloModuleChatV1
  commit(): void
  activate(): void
} {
  assertModuleId(moduleId, 'Module id')
  const staged = new Map<string, YoloModuleChatModeV1>()
  const published = new Set<string>()
  const stagedToolSets = new Map<string, YoloModuleToolSetV1>()
  const publishedToolSets = new Set<string>()
  const publishedRenderers = new Set<YoloModuleFileTextRendererV1>()
  let active = true
  let committed = false
  let activationComplete = false
  lifecycle.add(() => {
    active = false
    activationComplete = false
    staged.clear()
    stagedToolSets.clear()
    for (const id of published) sink.remove(moduleId, id)
    published.clear()
    for (const id of publishedToolSets) toolSetSink.remove(moduleId, id)
    publishedToolSets.clear()
    for (const renderer of publishedRenderers) {
      fileTextRendererSink.remove(moduleId, renderer)
    }
    publishedRenderers.clear()
  })
  const assertActive = (): void => {
    if (!active) throw new Error(`Module "${moduleId}" is no longer active`)
  }
  const api: YoloModuleChatV1 = Object.freeze({
    registerMode: (mode) => {
      assertActive()
      if (committed) {
        throw new Error('Module chat modes are already committed')
      }
      const snapshot = snapshotModuleChatMode(mode)
      if (staged.has(snapshot.id)) {
        throw new Error(`Duplicate module chat mode id "${snapshot.id}"`)
      }
      if (staged.size >= MAX_MODULE_CHAT_MODES_PER_MODULE) {
        throw new Error(
          `Module "${moduleId}" cannot register more than ${MAX_MODULE_CHAT_MODES_PER_MODULE} chat modes`,
        )
      }
      staged.set(snapshot.id, snapshot)
    },
    registerToolSet: (set) => {
      assertActive()
      if (committed) {
        throw new Error('Module tool sets are already committed')
      }
      const snapshot = snapshotModuleToolSet(set)
      if (stagedToolSets.has(snapshot.id)) {
        throw new Error(`Duplicate module tool set id "${snapshot.id}"`)
      }
      if (stagedToolSets.size >= MAX_MODULE_TOOL_SETS_PER_MODULE) {
        throw new Error(
          `Module "${moduleId}" cannot register more than ${MAX_MODULE_TOOL_SETS_PER_MODULE} tool sets`,
        )
      }
      stagedToolSets.set(snapshot.id, snapshot)
    },
    // Published immediately rather than staged to `commit()`: a renderer is
    // not part of the frozen contribution set the way a mode or a tool set
    // is — it answers a read that can arrive at any time, it carries no id
    // to collide on within a module, and it hands back its own disposer so a
    // module may retire one mid-life.
    registerFileTextRenderer: (renderer) => {
      assertActive()
      const snapshot = snapshotModuleFileTextRenderer(renderer)
      fileTextRendererSink.add(moduleId, snapshot)
      publishedRenderers.add(snapshot)
      return () => {
        if (!publishedRenderers.delete(snapshot)) return
        fileTextRendererSink.remove(moduleId, snapshot)
      }
    },
  })
  return {
    api,
    commit: () => {
      assertActive()
      if (committed) {
        throw new Error('Module capabilities are already committed')
      }
      committed = true
      for (const [id, mode] of staged) {
        published.add(id)
        sink.add(moduleId, mode)
      }
      staged.clear()
      for (const [id, set] of stagedToolSets) {
        // Added before `add` can throw on a contested id, so the lifecycle
        // disposer still revokes the sets that did publish. `remove` is
        // owner-guarded, so revoking an id we lost is a no-op.
        publishedToolSets.add(id)
        toolSetSink.add(moduleId, set)
      }
      stagedToolSets.clear()
    },
    activate: () => {
      assertActive()
      if (activationComplete) {
        throw new Error('Module capabilities are already active')
      }
      activationComplete = true
    },
  }
}

function createModuleBackgroundCapability({
  moduleId,
  lifecycle,
  sink,
  now,
  reportCallbackError,
}: {
  moduleId: string
  lifecycle: ModuleLifecycleScope
  sink: BackgroundActivityBatchSink
  now: () => number
  reportCallbackError: (moduleId: string, error: unknown) => void
}): {
  api: YoloModuleBackgroundV1
  commit(): void
  activate(): void
} {
  const staged = new Map<string, BackgroundActivity>()
  const publishedIds = new Set<string>()
  const callbackTokens = new Map<string, object>()
  let active = true
  let committed = false
  let activationComplete = false
  lifecycle.add(() => {
    active = false
    staged.clear()
    callbackTokens.clear()
    const errors: unknown[] = []
    for (const id of publishedIds) {
      try {
        sink.remove(id)
        publishedIds.delete(id)
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 0) throw new ModuleBackgroundCleanupError(errors)
  })

  const resolveId = (localId: string): string => {
    requireText(localId, 'Background activity id')
    return `module:${JSON.stringify([moduleId, localId])}`
  }
  const assertActive = (): void => {
    if (!active) throw new Error(`Module "${moduleId}" is no longer active`)
  }
  const reportError = (error: unknown): void => {
    try {
      reportCallbackError(moduleId, error)
    } catch {
      // Error reporting must not let module callbacks escape the host boundary.
    }
  }

  const api = Object.freeze({
    upsert: (activity: YoloModuleBackgroundActivityV1) => {
      assertActive()
      const declaration = snapshotActivity(activity)
      validateActivity(declaration)
      const id = resolveId(declaration.id)
      const onOpen = declaration.onOpen
      const callbackToken = onOpen ? {} : null
      if (callbackToken) callbackTokens.set(id, callbackToken)
      else callbackTokens.delete(id)
      const mapped: BackgroundActivity = {
        id,
        kind: `module:${moduleId}`,
        title: declaration.title,
        ...(declaration.detail !== undefined
          ? { detail: declaration.detail }
          : {}),
        ...(declaration.summary !== undefined
          ? { summary: declaration.summary }
          : {}),
        ...(declaration.icon !== undefined ? { icon: declaration.icon } : {}),
        status: declaration.status,
        updatedAt: now(),
        ...(onOpen
          ? {
              action: {
                type: 'callback',
                run: () => {
                  if (
                    !active ||
                    !activationComplete ||
                    callbackTokens.get(id) !== callbackToken
                  )
                    return
                  try {
                    const result = onOpen()
                    if (isThenable(result)) {
                      void Promise.resolve(result).catch((error: unknown) => {
                        reportError(error)
                      })
                    }
                  } catch (error) {
                    reportError(error)
                  }
                },
              } as const,
            }
          : {}),
      }
      if (!committed) {
        staged.set(id, mapped)
        return
      }
      publishedIds.add(id)
      sink.upsert(mapped)
    },
    remove: (localId: string) => {
      assertActive()
      const id = resolveId(localId)
      callbackTokens.delete(id)
      if (!committed) {
        staged.delete(id)
        return
      }
      sink.remove(id)
      publishedIds.delete(id)
    },
  })
  return {
    api,
    commit: () => {
      assertActive()
      if (committed)
        throw new Error('Module capabilities are already committed')
      committed = true
      for (const id of staged.keys()) publishedIds.add(id)
      if (staged.size > 0) sink.upsertAll([...staged.values()])
      staged.clear()
    },
    activate: () => {
      assertActive()
      if (activationComplete)
        throw new Error('Module capabilities are already active')
      lifecycle.add(() => {
        activationComplete = false
      })
      activationComplete = true
    },
  }
}

function snapshotActivity(
  activity: YoloModuleBackgroundActivityV1,
): YoloModuleBackgroundActivityV1 {
  if (!activity || typeof activity !== 'object') {
    throw new TypeError('Background activity must be an object')
  }
  const id = activity.id
  const title = activity.title
  const detail = activity.detail
  const summary = activity.summary
  const icon = activity.icon
  const status = activity.status
  const onOpen = activity.onOpen
  return { id, title, detail, summary, icon, status, onOpen }
}

function validateActivity(activity: YoloModuleBackgroundActivityV1): void {
  requireText(activity.title, 'Background activity title')
  requireOptionalString(activity.detail, 'Background activity detail')
  requireOptionalString(activity.summary, 'Background activity summary')
  if (activity.icon !== undefined) {
    requireText(activity.icon, 'Background activity icon')
  }
  if (
    activity.status !== 'running' &&
    activity.status !== 'waiting' &&
    activity.status !== 'failed' &&
    activity.status !== 'reminder'
  ) {
    throw new Error('Background activity status is invalid')
  }
  if (activity.onOpen !== undefined && typeof activity.onOpen !== 'function') {
    throw new TypeError('Background activity onOpen must be a function')
  }
}

function requireOptionalString(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new TypeError(`${label} must be a string`)
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  )
}

function requireText(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`)
  }
}
