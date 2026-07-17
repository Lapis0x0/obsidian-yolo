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
import type {
  ModuleConfigCapabilityActivationV1,
  ModuleConfigV1,
} from './moduleConfig'
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
  type ModuleUiCapabilityProviderV1,
  UNAVAILABLE_MODULE_UI_CAPABILITY_PROVIDER,
} from './moduleUi'
import {
  type ModuleVaultCapabilityProviderV1,
  UNAVAILABLE_MODULE_VAULT_CAPABILITY_PROVIDER,
} from './moduleVault'
import type {
  YoloModuleBackgroundActivityV1,
  YoloModuleBackgroundV1,
  YoloModuleCapabilitiesV1,
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
  config?: ModuleConfigCapabilityProviderV1
  paths?: ModulePathsCapabilityProviderV1
  privateStorage?: ModulePrivateStorageCapabilityProviderV1
  ui?: ModuleUiCapabilityProviderV1
  vault?: ModuleVaultCapabilityProviderV1
  now?: () => number
  reportCallbackError?: (moduleId: string, error: unknown) => void
}

export class CoreModuleHostCapabilityProvider
  implements ModuleHostCapabilityProviderV1
{
  private readonly agent: ModuleAgentCapabilityProviderV1
  private readonly assets: ModuleAssetsCapabilityProviderV1
  private readonly backgroundActivities: BackgroundActivityBatchSink
  private readonly config: ModuleConfigCapabilityProviderV1
  private readonly now: () => number
  private readonly paths: ModulePathsCapabilityProviderV1
  private readonly privateStorage: ModulePrivateStorageCapabilityProviderV1
  private readonly ui: ModuleUiCapabilityProviderV1
  private readonly reportCallbackError: (
    moduleId: string,
    error: unknown,
  ) => void
  private readonly vault: ModuleVaultCapabilityProviderV1

  constructor({
    agent = UNAVAILABLE_MODULE_AGENT_CAPABILITY_PROVIDER,
    assets = UNAVAILABLE_MODULE_ASSETS_CAPABILITY_PROVIDER,
    backgroundActivities,
    config = UNAVAILABLE_MODULE_CONFIG_CAPABILITY_PROVIDER,
    paths = UNAVAILABLE_MODULE_PATHS_CAPABILITY_PROVIDER,
    privateStorage = UNAVAILABLE_MODULE_PRIVATE_STORAGE_CAPABILITY_PROVIDER,
    ui = UNAVAILABLE_MODULE_UI_CAPABILITY_PROVIDER,
    vault = UNAVAILABLE_MODULE_VAULT_CAPABILITY_PROVIDER,
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
    this.config = config
    this.paths = paths
    this.privateStorage = privateStorage
    this.ui = ui
    this.vault = vault
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
    const config = this.config.create(moduleId, lifecycle)
    const paths = this.paths.create(moduleId, lifecycle)
    const privateStorage = this.privateStorage.create(moduleId, lifecycle)
    const ui = this.ui.create(moduleId, lifecycle)
    const vault = this.vault.create(moduleId, lifecycle)
    return Object.freeze({
      capabilities: Object.freeze({
        agent: agent.api,
        assets: assets.api,
        background: background.api,
        config: config.api,
        paths: paths.api,
        privateStorage: privateStorage.api,
        ui: ui.api,
        vault: vault.api,
      }),
      prepare: () => config.activate(),
      commit: () => background.commit(),
      activate: () => {
        agent.activate()
        assets.activate()
        background.activate()
        paths.activate()
        privateStorage.activate()
        ui.activate()
        vault.activate()
      },
    })
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
