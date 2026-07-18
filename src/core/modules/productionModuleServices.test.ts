// eslint-disable-next-line import/no-nodejs-modules -- production composition tests use Node's Web Crypto implementation
import { createHash, webcrypto } from 'node:crypto'

import type { DataAdapter, RequestUrlParam, RequestUrlResponse } from 'obsidian'

import { ModuleLifecycleScope } from './lifecycleScope'
import { ModuleAssetsCapabilityProvider } from './moduleAssets'
import { ModuleDeviceStateStore } from './moduleDeviceStateStore'
import type { ModuleIntent } from './moduleIntentStore'
import { ModuleReadinessReconciler } from './moduleReadinessReconciler'
import { ModuleRuntimeReservation } from './moduleRuntimeReservation'
import { ModuleStore } from './moduleStore'
import {
  hashModuleTransitionSettingsSnapshot,
  parseModuleTransitionJournal,
} from './moduleTransitionJournal'
import { OFFICIAL_MODULE_CATALOG_URL } from './officialModuleCatalogClient'
import { createOfficialModuleCompatibilityProvider } from './officialModuleCompatibilityProvider'
import {
  OFFICIAL_MODULE_ARTIFACT_TIMEOUT_MS,
  OFFICIAL_MODULE_CATALOG_CACHE_PATH,
  OFFICIAL_MODULE_CATALOG_CACHE_TTL_MS,
  OFFICIAL_MODULE_CATALOG_TIMEOUT_MS,
  createProductionModuleServices,
} from './productionModuleServices'

const encode = (value: string): Uint8Array => new TextEncoder().encode(value)
const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')

class MemoryAdapter {
  readonly textFiles = new Map<string, string>()
  readonly binaryFiles = new Map<string, ArrayBuffer>()
  readonly folders = new Set<string>()

  async exists(path: string): Promise<boolean> {
    return (
      this.textFiles.has(path) ||
      this.binaryFiles.has(path) ||
      this.folders.has(path)
    )
  }

  async stat(
    path: string,
  ): Promise<{ type: 'file' | 'folder'; size: number } | null> {
    const text = this.textFiles.get(path)
    if (text !== undefined) {
      return { type: 'file', size: encode(text).byteLength }
    }
    const binary = this.binaryFiles.get(path)
    if (binary !== undefined) return { type: 'file', size: binary.byteLength }
    return this.folders.has(path) ? { type: 'folder', size: 0 } : null
  }

  async mkdir(path: string): Promise<void> {
    const parts = path.split('/').filter(Boolean)
    let current = ''
    for (const part of parts) {
      current = current ? `${current}/${part}` : part
      this.folders.add(current)
    }
  }

  async read(path: string): Promise<string> {
    const value = this.textFiles.get(path)
    if (value === undefined) throw new Error(`Missing text file: ${path}`)
    return value
  }

  async write(path: string, value: string): Promise<void> {
    await this.ensureParent(path)
    this.textFiles.set(path, value)
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const value = this.binaryFiles.get(path)
    if (value === undefined) throw new Error(`Missing binary file: ${path}`)
    return value.slice(0)
  }

  async writeBinary(path: string, value: ArrayBuffer): Promise<void> {
    await this.ensureParent(path)
    this.binaryFiles.set(path, value.slice(0))
  }

  async remove(path: string): Promise<void> {
    this.textFiles.delete(path)
    this.binaryFiles.delete(path)
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = `${path}/`
    const files = [...this.textFiles.keys(), ...this.binaryFiles.keys()].filter(
      (entry) =>
        entry.startsWith(prefix) && !entry.slice(prefix.length).includes('/'),
    )
    const folders = [...this.folders].filter(
      (entry) =>
        entry !== path &&
        entry.startsWith(prefix) &&
        !entry.slice(prefix.length).includes('/'),
    )
    return { files, folders }
  }

  async rmdir(path: string, recursive: boolean): Promise<void> {
    const prefix = `${path}/`
    const hasChildren = [
      ...this.textFiles.keys(),
      ...this.binaryFiles.keys(),
      ...this.folders,
    ].some((entry) => entry.startsWith(prefix))
    if (!recursive && hasChildren)
      throw new Error(`Folder is not empty: ${path}`)
    for (const file of [...this.textFiles.keys()]) {
      if (file.startsWith(prefix)) this.textFiles.delete(file)
    }
    for (const file of [...this.binaryFiles.keys()]) {
      if (file.startsWith(prefix)) this.binaryFiles.delete(file)
    }
    for (const folder of [...this.folders]) {
      if (folder === path || folder.startsWith(prefix))
        this.folders.delete(folder)
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const prefix = `${from}/`
    const folders = [...this.folders].filter(
      (entry) => entry === from || entry.startsWith(prefix),
    )
    const textFiles = [...this.textFiles].filter(([entry]) =>
      entry.startsWith(prefix),
    )
    const binaryFiles = [...this.binaryFiles].filter(([entry]) =>
      entry.startsWith(prefix),
    )
    for (const folder of folders) this.folders.delete(folder)
    for (const [file] of textFiles) this.textFiles.delete(file)
    for (const [file] of binaryFiles) this.binaryFiles.delete(file)
    for (const folder of folders) {
      this.folders.add(`${to}${folder.slice(from.length)}`)
    }
    for (const [file, value] of textFiles) {
      this.textFiles.set(`${to}${file.slice(from.length)}`, value)
    }
    for (const [file, value] of binaryFiles) {
      this.binaryFiles.set(`${to}${file.slice(from.length)}`, value)
    }
  }

  private async ensureParent(path: string): Promise<void> {
    const separator = path.lastIndexOf('/')
    if (separator > 0) await this.mkdir(path.slice(0, separator))
  }
}

function response(body: string | Uint8Array, status = 200): RequestUrlResponse {
  const bytes = typeof body === 'string' ? encode(body) : body
  return {
    status,
    headers: { 'content-length': String(bytes.byteLength) },
    text:
      typeof body === 'string' ? body : new TextDecoder('utf-8').decode(body),
    arrayBuffer: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ),
    json: null,
  }
}

function artifact(withStyle = false) {
  const releaseRoot =
    'https://github.com/Lapis0x0/obsidian-yolo/releases/download/module-learning-v1.2.3'
  const entryUrl = `${releaseRoot}/entry.js`
  const styleUrl = `${releaseRoot}/style.css`
  const manifestUrl = `${releaseRoot}/module.json`
  const entryBytes = encode('globalThis.yoloModuleLoaded = true')
  const styleBytes = encode('.learning { color: red; }')
  const files = [
    {
      role: 'entry',
      name: 'entry.js',
      path: 'entry.js',
      byteSize: entryBytes.byteLength,
      sha256: sha256(entryBytes),
      url: entryUrl,
      storage: 'module',
    },
    ...(withStyle
      ? [
          {
            role: 'style',
            name: 'style.css',
            path: 'style.css',
            byteSize: styleBytes.byteLength,
            sha256: sha256(styleBytes),
            url: styleUrl,
            storage: 'module',
          },
        ]
      : []),
  ]
  const manifestBytes = encode(
    `${JSON.stringify({
      schemaVersion: 1,
      id: 'learning',
      version: '1.2.3',
      hostApi: '>=1.0.0 <2.0.0',
      dataSchemas: { settings: { readMin: 0, readMax: 1, write: 1 } },
      variants: [
        {
          platform: 'desktop',
          entry: 'entry.js',
          files,
        },
      ],
    })}\n`,
  )
  const catalog = JSON.stringify({
    schemaVersion: 1,
    modules: [
      {
        id: 'learning',
        name: 'Learning',
        description: 'Spaced repetition',
        versions: [
          {
            version: '1.2.3',
            hostApi: '>=1.0.0 <2.0.0',
            platforms: ['desktop'],
            dataSchemas: {
              settings: { readMin: 0, readMax: 1, write: 1 },
            },
            manifestUrl,
            manifest: {
              byteSize: manifestBytes.byteLength,
              sha256: sha256(manifestBytes),
            },
          },
        ],
      },
    ],
  })
  return {
    catalog,
    entryBytes,
    entryUrl,
    manifestBytes,
    manifestUrl,
    styleBytes,
    styleUrl,
  }
}

function createHarness(
  overrides: {
    catalogRequest?: (request: RequestUrlParam) => Promise<RequestUrlResponse>
    artifactRequest?: (request: RequestUrlParam) => Promise<RequestUrlResponse>
    authorizeArtifactRemoval?:
      | ((moduleId: string, versions: readonly string[]) => Promise<boolean>)
      | null
    intentStore?: null
    withStyle?: boolean
  } = {},
) {
  const fixture = artifact(overrides.withStyle)
  const adapter = new MemoryAdapter()
  const cacheAdapter = new MemoryAdapter()
  const dataAdapter = adapter as unknown as DataAdapter
  const store = new ModuleStore({
    adapter: dataAdapter,
    manifest: { id: 'yolo', dir: 'config/plugins/yolo' },
    configDir: 'config',
  })
  const deviceStateStore = new ModuleDeviceStateStore({
    kind: 'device-local-runtime-state',
    adapter,
    rootPath: 'device/module-state',
  })
  const catalogRequest = jest.fn(
    overrides.catalogRequest ?? (async () => response(fixture.catalog)),
  )
  const artifactRequest = jest.fn(
    overrides.artifactRequest ??
      (async (request: RequestUrlParam) => {
        if (request.url === fixture.manifestUrl) {
          return response(fixture.manifestBytes)
        }
        if (request.url === fixture.entryUrl)
          return response(fixture.entryBytes)
        if (request.url === fixture.styleUrl)
          return response(fixture.styleBytes)
        return response('', 404)
      }),
  )
  const activeVersions = new Map<string, string>()
  const intents = new Map<string, ModuleIntent>([
    ['learning', { desiredInstalled: true, enabled: true }],
  ])
  const intentListeners = new Set<(moduleId: string) => void>()
  const intentStore = {
    get: jest.fn(async (moduleId: string) => intents.get(moduleId)),
    set: jest.fn(async (moduleId: string, intent: ModuleIntent) => {
      const persisted = Object.freeze({ ...intent })
      intents.set(moduleId, persisted)
      return persisted
    }),
    listModuleIds: jest.fn(async () => [...intents.keys()]),
    subscribeAll: jest.fn((listener: (moduleId: string) => void) => {
      intentListeners.add(listener)
      return () => intentListeners.delete(listener)
    }),
  }
  const isActive = jest.fn(
    (moduleId: string, version: string) =>
      activeVersions.get(moduleId) === version,
  )
  const activationLoader = {
    load: jest.fn(async (entry: { id: string }) => ({
      id: entry.id,
      activate: () => undefined,
    })),
  }
  const activationRuntime = {
    isActive: jest.fn((moduleId: string) => activeVersions.has(moduleId)),
    activate: jest.fn(async (definition: { id: string }, version: string) => {
      activeVersions.set(definition.id, version)
    }),
  }
  const runtimeReservation = new ModuleRuntimeReservation({
    runtime: activationRuntime,
  })
  const authorizeArtifactRemoval = jest.fn(
    overrides.authorizeArtifactRemoval ?? (async () => true),
  )
  const requestReload = jest.fn()
  const reportStartupError = jest.fn()
  const transitionSettingsSnapshot = Object.freeze({
    present: true as const,
    envelope: Object.freeze({
      schemaVersion: 1,
      data: Object.freeze({ enabled: true }),
    }),
  })
  const transitionSettingsLocation = Object.freeze({
    moduleId: 'learning',
    storageRoot: 'YOLO/.yolo_json_db/module-settings',
    storagePath: 'YOLO/.yolo_json_db/module-settings/learning.json',
  })
  const captureSettings = jest.fn(async () =>
    Object.freeze({
      location: transitionSettingsLocation,
      snapshot: transitionSettingsSnapshot,
    }),
  )
  const readAtCapturedLocation = jest.fn(async () => transitionSettingsSnapshot)
  const services = createProductionModuleServices({
    store,
    deviceStateStore,
    catalogCacheAdapter: cacheAdapter,
    platform: 'desktop',
    getCompatibility: createOfficialModuleCompatibilityProvider({
      platform: 'desktop',
      readDeviceState: (moduleId) => deviceStateStore.read(moduleId),
      readSettingsSchemaVersion: async () => 0,
    }),
    isActive,
    ...(overrides.intentStore === null ? {} : { intentStore }),
    activationLoader,
    activationRuntime,
    runtimeReservation,
    ...(overrides.authorizeArtifactRemoval === null
      ? {}
      : { authorizeArtifactRemoval }),
    transitionSettingsBackend: {
      capture: captureSettings,
      readAtCapturedLocation,
    },
    transitionRecoveryRealmToken: {},
    readCurrentSchemaVersion: async () => 1,
    catalogRequest,
    artifactRequest,
    subtleCrypto: webcrypto.subtle as unknown as SubtleCrypto,
    requestReload,
    reportStartupError,
  })
  return {
    adapter,
    artifactRequest,
    cacheAdapter,
    catalogRequest,
    deviceStateStore,
    fixture,
    isActive,
    intents,
    intentStore,
    emitIntent(moduleId: string) {
      for (const listener of [...intentListeners]) listener(moduleId)
    },
    intentListenerCount: () => intentListeners.size,
    activeVersions,
    activationLoader,
    activationRuntime,
    authorizeArtifactRemoval,
    requestReload,
    reportStartupError,
    runtimeReservation,
    store,
    captureSettings,
    readAtCapturedLocation,
    transitionSettingsLocation,
    transitionSettingsSnapshot,
    services,
  }
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

describe('createProductionModuleServices', () => {
  it('exports the production cache path, TTL, and request timeouts', () => {
    expect(OFFICIAL_MODULE_CATALOG_CACHE_PATH).toBe(
      'official-module-catalog/catalog-v1.json',
    )
    expect(OFFICIAL_MODULE_CATALOG_CACHE_TTL_MS).toBe(6 * 60 * 60 * 1_000)
    expect(OFFICIAL_MODULE_CATALOG_TIMEOUT_MS).toBe(10_000)
    expect(OFFICIAL_MODULE_ARTIFACT_TIMEOUT_MS).toBe(30_000)
  })

  it('discovers, snapshots, downloads, installs, and reports real device state', async () => {
    const harness = createHarness({ withStyle: true })

    await harness.services.manager.refresh()

    expect(harness.services.manager.getSnapshot().errors).toEqual({})
    expect(harness.services.manager.getSnapshot()).toMatchObject({
      status: 'ready',
      modules: [
        {
          id: 'learning',
          name: 'Learning',
          version: '1.2.3',
          status: 'available',
        },
      ],
    })
    expect(harness.catalogRequest).toHaveBeenCalledWith({
      url: OFFICIAL_MODULE_CATALOG_URL,
      method: 'GET',
      throw: false,
    })

    const candidate = harness.services.getInstallCandidate('learning')
    expect(candidate).toEqual({
      moduleId: 'learning',
      expectedVersion: '1.2.3',
      expectedManifestSha256: sha256(harness.fixture.manifestBytes),
    })
    expect(Object.isFrozen(candidate)).toBe(true)
    expect(harness.services.getInstallCandidate('missing')).toBeUndefined()
    expect(() => harness.services.getInstallCandidate('../learning')).toThrow(
      'Module id',
    )

    await harness.services.installConfirmedCandidate(candidate!)

    expect(
      harness.artifactRequest.mock.calls.map(([request]) => request),
    ).toEqual([
      { url: harness.fixture.manifestUrl, method: 'GET', throw: false },
      { url: harness.fixture.entryUrl, method: 'GET', throw: false },
      { url: harness.fixture.styleUrl, method: 'GET', throw: false },
    ])
    expect(
      harness.adapter.binaryFiles.has(
        'config/plugins/yolo/modules/learning/1.2.3/entry.js',
      ),
    ).toBe(true)
    expect(await harness.deviceStateStore.read('learning')).toMatchObject({
      moduleId: 'learning',
      platform: 'desktop',
      activeVersion: null,
      downloadedCandidate: '1.2.3',
    })
    expect(harness.services.manager.getSnapshot().modules[0]?.status).toBe(
      'ready-to-apply',
    )

    const installed = (await harness.deviceStateStore.read('learning'))!
    await harness.deviceStateStore.write({
      ...installed,
      activeVersion: '1.2.3',
      downloadedCandidate: null,
    })
    await harness.services.activationCoordinator.activatePersistedModules()
    await harness.services.manager.refresh()
    expect(harness.isActive).toHaveBeenCalledWith('learning', '1.2.3')
    expect(harness.services.manager.getSnapshot().modules[0]?.status).toBe(
      'active',
    )

    const lifecycle = new ModuleLifecycleScope()
    const assets = new ModuleAssetsCapabilityProvider({
      store: harness.store,
      getVerifiedArtifact: harness.services.getVerifiedArtifact,
      subtleCrypto: webcrypto.subtle as unknown as SubtleCrypto,
    }).create('learning', lifecycle)
    assets.activate()
    await expect(assets.api.readText('style.css')).resolves.toBe(
      '.learning { color: red; }',
    )
    expect(
      harness.services.getVerifiedArtifact('learning')?.manifest.version,
    ).toBe('1.2.3')

    harness.services.dispose()
    expect(harness.services.getVerifiedArtifact('learning')).toBeUndefined()
    lifecycle.dispose()

    await flushPromises()
    expect(
      harness.cacheAdapter.textFiles.has(OFFICIAL_MODULE_CATALOG_CACHE_PATH),
    ).toBe(true)
    expect(
      harness.adapter.textFiles.has(OFFICIAL_MODULE_CATALOG_CACHE_PATH),
    ).toBe(false)
    expect(
      [
        ...harness.cacheAdapter.textFiles.keys(),
        ...harness.cacheAdapter.folders,
      ].every((path) => path.startsWith('official-module-catalog')),
    ).toBe(true)
    harness.services.dispose()
    expect(harness.services.manager.getSnapshot().status).toBe('loading')
  })

  it('composes synchronized intent, readiness, and the guarded activation seam', async () => {
    const harness = createHarness()
    harness.intents.set('learning', {
      desiredInstalled: false,
      enabled: false,
    })
    const {
      intentCoordinator,
      intentStateSource,
      readinessReconciler,
      runtimeReservation,
    } = harness.services
    expect(intentCoordinator).not.toBeNull()
    expect(intentStateSource).not.toBeNull()
    expect(readinessReconciler).not.toBeNull()
    expect(harness.services.startupReconciler).not.toBeNull()
    expect(runtimeReservation).not.toBeNull()
    expect(runtimeReservation).toBe(harness.runtimeReservation)
    expect(harness.services.uninstallCoordinator).not.toBeNull()

    await harness.services.manager.refresh()
    await expect(intentCoordinator!.install('learning')).resolves.toEqual({
      desiredInstalled: true,
      enabled: false,
    })
    expect(harness.services.manager.getSnapshot().modules[0]).toMatchObject({
      id: 'learning',
      desiredInstalled: true,
      enabled: false,
    })

    await expect(
      readinessReconciler!.ensureModuleReady('learning'),
    ).resolves.toMatchObject({
      moduleId: 'learning',
      status: 'ready',
      installedVersion: '1.2.3',
    })
    expect(await harness.deviceStateStore.read('learning')).toMatchObject({
      downloadedCandidate: '1.2.3',
    })
    await expect(intentCoordinator!.enable('learning')).resolves.toEqual({
      desiredInstalled: true,
      enabled: true,
    })

    const installed = (await harness.deviceStateStore.read('learning'))!
    await harness.deviceStateStore.write({
      ...installed,
      activeVersion: '1.2.3',
      downloadedCandidate: null,
    })
    await harness.services.activationCoordinator.activatePersistedModules()
    expect(harness.activationRuntime.activate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'learning' }),
      '1.2.3',
      expect.any(AbortSignal),
    )
  })

  it('owns startup ordering across readiness, refresh, and activation', async () => {
    const harness = createHarness()
    const ensureModuleReady = jest.spyOn(
      ModuleReadinessReconciler.prototype,
      'ensureModuleReady',
    )
    const refresh = jest.spyOn(harness.services.manager, 'refresh')
    const activatePersistedModules = jest.spyOn(
      harness.services.activationCoordinator,
      'activatePersistedModules',
    )

    await harness.services.startupReconciler!.start()

    expect(harness.intentStore.subscribeAll).toHaveBeenCalledTimes(1)
    expect(harness.intentStore.listModuleIds).toHaveBeenCalledTimes(1)
    expect(
      harness.intentStore.subscribeAll.mock.invocationCallOrder[0],
    ).toBeLessThan(
      harness.intentStore.listModuleIds.mock.invocationCallOrder[0],
    )
    expect(ensureModuleReady).toHaveBeenCalledWith('learning')
    expect(ensureModuleReady.mock.invocationCallOrder[0]).toBeLessThan(
      refresh.mock.invocationCallOrder[0],
    )
    expect(refresh.mock.invocationCallOrder[0]).toBeLessThan(
      activatePersistedModules.mock.invocationCallOrder[0],
    )
  })

  it('reconciles module ids added by the external intent subscription', async () => {
    const harness = createHarness()
    harness.intents.set('learning', {
      desiredInstalled: false,
      enabled: false,
    })
    await harness.services.startupReconciler!.start()
    const ensureModuleReady = jest.spyOn(
      ModuleReadinessReconciler.prototype,
      'ensureModuleReady',
    )

    harness.intents.set('notes', {
      desiredInstalled: true,
      enabled: false,
    })
    harness.emitIntent('notes')
    await harness.services.startupReconciler!.whenIdle()

    expect(harness.intentStore.get).toHaveBeenCalledWith('notes')
    expect(ensureModuleReady).toHaveBeenCalledWith('notes')

    harness.intents.set('notes', {
      desiredInstalled: true,
      enabled: true,
    })
    harness.emitIntent('notes')
    await harness.services.startupReconciler!.whenIdle()
    expect(harness.requestReload).toHaveBeenCalledWith('notes')
  })

  it('unions intent, device-state, and catalog module ids at startup', async () => {
    const harness = createHarness()
    harness.intents.clear()
    harness.intentStore.listModuleIds.mockResolvedValue(['intent-only'])
    await harness.deviceStateStore.write({
      moduleId: 'device-only',
      platform: 'desktop',
      activeVersion: null,
      downloadedCandidate: null,
      pendingVersion: null,
      readyVersions: {},
      transition: null,
    })

    await harness.services.startupReconciler!.start()

    expect(
      harness.intentStore.get.mock.calls
        .map(([moduleId]) => moduleId)
        .slice(0, 3),
    ).toEqual(['device-only', 'intent-only', 'learning'])
  })

  it('starts a local active module when an uncached catalog load fails', async () => {
    const harness = createHarness()
    await harness.services.manager.refresh()
    await harness.services.readinessReconciler!.ensureModuleReady('learning')
    const installed = (await harness.deviceStateStore.read('learning'))!
    await harness.deviceStateStore.write({
      ...installed,
      activeVersion: '1.2.3',
      downloadedCandidate: null,
    })
    harness.intents.set('catalog-only', {
      desiredInstalled: true,
      enabled: true,
    })
    await flushPromises()
    harness.cacheAdapter.textFiles.clear()
    harness.cacheAdapter.folders.clear()
    harness.catalogRequest.mockResolvedValue(response('', 503))
    expect(
      await harness.cacheAdapter.stat(OFFICIAL_MODULE_CATALOG_CACHE_PATH),
    ).toBeNull()

    await harness.services.startupReconciler!.start()

    expect(harness.activationRuntime.activate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'learning' }),
      '1.2.3',
      expect.any(AbortSignal),
    )
    expect(harness.reportStartupError.mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            message: 'Official module catalog is unavailable',
          }),
        ],
        [
          expect.objectContaining({
            message: expect.stringContaining(
              'has no resolved installation candidate',
            ),
          }),
          'catalog-only',
        ],
      ]),
    )
  })

  it('recovers a disabled transition when an uncached catalog load fails', async () => {
    const harness = createHarness()
    await harness.services.manager.refresh()
    await harness.services.readinessReconciler!.ensureModuleReady('learning')
    const candidate = await harness.services.getTransitionCandidate('learning')
    await harness.services.prepareConfirmedTransition(candidate!)
    harness.intents.set('learning', {
      desiredInstalled: true,
      enabled: false,
    })
    await flushPromises()
    harness.cacheAdapter.textFiles.clear()
    harness.cacheAdapter.folders.clear()
    harness.catalogRequest.mockResolvedValue(response('', 503))
    expect(
      await harness.cacheAdapter.stat(OFFICIAL_MODULE_CATALOG_CACHE_PATH),
    ).toBeNull()

    await harness.services.startupReconciler!.start()

    expect(harness.activationRuntime.activate).not.toHaveBeenCalled()
    expect(await harness.deviceStateStore.read('learning')).toMatchObject({
      activeVersion: null,
      downloadedCandidate: '1.2.3',
      pendingVersion: null,
      transition: null,
    })
  })

  it('settles startup without runtime execution when installed intent is disabled', async () => {
    const harness = createHarness()
    harness.intents.set('learning', {
      desiredInstalled: true,
      enabled: false,
    })
    const activatePersistedModules = jest.spyOn(
      harness.services.activationCoordinator,
      'activatePersistedModules',
    )

    await harness.services.startupReconciler!.start()

    expect(activatePersistedModules).toHaveBeenCalledTimes(1)
    expect(harness.activationRuntime.activate).not.toHaveBeenCalled()
  })

  it('removes stale active state when the current runtime is quiescent', async () => {
    const harness = createHarness()
    await harness.services.manager.refresh()
    await harness.services.readinessReconciler!.ensureModuleReady('learning')
    const installed = (await harness.deviceStateStore.read('learning'))!
    await harness.deviceStateStore.write({
      ...installed,
      activeVersion: '1.2.3',
      downloadedCandidate: null,
    })
    harness.intents.set('learning', {
      desiredInstalled: false,
      enabled: false,
    })

    await harness.services.startupReconciler!.start()

    expect(harness.reportStartupError).not.toHaveBeenCalled()
    expect(await harness.deviceStateStore.read('learning')).toBeNull()
    expect(harness.authorizeArtifactRemoval).toHaveBeenCalledWith('learning', [
      '1.2.3',
    ])
  })

  it('does not uninstall while a transition is still unresolved', async () => {
    const harness = createHarness()
    await harness.services.manager.refresh()
    await harness.services.readinessReconciler!.ensureModuleReady('learning')
    const candidate = await harness.services.getTransitionCandidate('learning')
    await harness.services.prepareConfirmedTransition(candidate!)
    harness.intents.set('learning', {
      desiredInstalled: false,
      enabled: false,
    })

    await harness.services.startupReconciler!.start()

    expect(harness.reportStartupError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('active transition'),
      }),
      'learning',
    )
    expect(await harness.deviceStateStore.read('learning')).toMatchObject({
      activeVersion: null,
      transition: expect.any(Object),
    })
    expect(harness.activationRuntime.activate).not.toHaveBeenCalled()
    expect(harness.authorizeArtifactRemoval).not.toHaveBeenCalled()
  })

  it('does not schedule safe uninstall without an uninstall coordinator', async () => {
    const harness = createHarness({ authorizeArtifactRemoval: null })
    await harness.services.manager.refresh()
    await harness.services.readinessReconciler!.ensureModuleReady('learning')
    harness.intents.set('learning', {
      desiredInstalled: false,
      enabled: false,
    })

    await harness.services.startupReconciler!.start()

    expect(await harness.deviceStateStore.read('learning')).not.toBeNull()
    expect(harness.reportStartupError).not.toHaveBeenCalled()
  })

  it('disposes the startup owner before its dependent services', async () => {
    const harness = createHarness()
    await harness.services.startupReconciler!.start()
    const startupDispose = jest.spyOn(
      harness.services.startupReconciler!,
      'dispose',
    )
    const readinessDispose = jest.spyOn(
      ModuleReadinessReconciler.prototype,
      'dispose',
    )
    const activationDispose = jest.spyOn(
      harness.services.activationCoordinator,
      'dispose',
    )

    harness.services.dispose()

    expect(harness.intentListenerCount()).toBe(0)
    expect(startupDispose.mock.invocationCallOrder[0]).toBeLessThan(
      readinessDispose.mock.invocationCallOrder[0],
    )
    expect(startupDispose.mock.invocationCallOrder[0]).toBeLessThan(
      activationDispose.mock.invocationCallOrder[0],
    )
  })

  it('fails closed by not exposing uninstall without a product policy', () => {
    const harness = createHarness({ authorizeArtifactRemoval: null })

    expect(harness.services.uninstallCoordinator).toBeNull()
  })

  it('rejects uninstall composition without an intent store', () => {
    expect(() => createHarness({ intentStore: null })).toThrow(
      'Production module services options are invalid',
    )
  })

  it('removes inactive artifacts only after intent is false, then refreshes', async () => {
    const harness = createHarness()
    await harness.services.manager.refresh()
    await harness.services.readinessReconciler!.ensureModuleReady('learning')
    harness.intents.set('learning', {
      desiredInstalled: false,
      enabled: false,
    })

    await harness.services.uninstallCoordinator!.uninstall('learning')

    expect(harness.authorizeArtifactRemoval).toHaveBeenCalledWith('learning', [
      '1.2.3',
    ])
    expect(await harness.deviceStateStore.read('learning')).toBeNull()
    expect(
      harness.adapter.folders.has('config/plugins/yolo/modules/learning/1.2.3'),
    ).toBe(false)
    expect(harness.services.manager.getSnapshot().modules[0]).toMatchObject({
      id: 'learning',
      status: 'available',
      desiredInstalled: false,
    })
  })

  it('mutually excludes activation and uninstall for the same module', async () => {
    const harness = createHarness()
    await harness.services.manager.refresh()
    await harness.services.readinessReconciler!.ensureModuleReady('learning')
    const installed = (await harness.deviceStateStore.read('learning'))!
    await harness.deviceStateStore.write({
      ...installed,
      activeVersion: '1.2.3',
      downloadedCandidate: null,
    })
    let activationEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      activationEntered = resolve
    })
    let releaseActivation!: () => void
    const activationGate = new Promise<void>((resolve) => {
      releaseActivation = resolve
    })
    harness.activationRuntime.activate.mockImplementationOnce(
      async (definition: { id: string }, version: string) => {
        activationEntered()
        await activationGate
        harness.activeVersions.set(definition.id, version)
      },
    )

    const activation =
      harness.services.activationCoordinator.activatePersistedModules()
    await entered
    harness.intents.set('learning', {
      desiredInstalled: false,
      enabled: false,
    })

    await expect(
      harness.services.uninstallCoordinator!.uninstall('learning'),
    ).rejects.toThrow('activation is pending and cannot be quiesced')
    expect(harness.authorizeArtifactRemoval).not.toHaveBeenCalled()
    expect(await harness.deviceStateStore.read('learning')).not.toBeNull()

    releaseActivation()
    await expect(activation).resolves.toEqual([
      { moduleId: 'learning', status: 'activated', version: '1.2.3' },
    ])
  })

  it('disposes owned services without disposing the external reservation', async () => {
    const harness = createHarness()
    const services = harness.services
    services.dispose()

    await expect(
      services.intentCoordinator!.enable('learning'),
    ).rejects.toThrow('coordinator is disposed')
    await expect(
      services.readinessReconciler!.reconcile(['learning']),
    ).rejects.toThrow('reconciler is disposed')
    await expect(
      services.runtimeReservation!.activate(
        {
          id: 'learning',
          activate: () => undefined,
        },
        '1.2.3',
      ),
    ).resolves.toBeUndefined()
    expect(services.runtimeReservation).toBe(harness.runtimeReservation)
  })

  it('surfaces catalog errors and does not commit state after artifact errors', async () => {
    const unavailable = createHarness({
      catalogRequest: async () => response('', 503),
    })
    await unavailable.services.manager.refresh()
    expect(unavailable.services.manager.getSnapshot()).toMatchObject({
      status: 'error',
      errors: { catalog: 'Official module catalog is unavailable' },
    })
    expect(unavailable.services.getInstallCandidate('learning')).toBeUndefined()

    const failedInstall = createHarness({
      artifactRequest: async () => response('', 503),
    })
    await failedInstall.services.manager.refresh()
    const candidate = failedInstall.services.getInstallCandidate('learning')!
    await expect(
      failedInstall.services.installConfirmedCandidate(candidate),
    ).rejects.toThrow('request was not successful')
    expect(await failedInstall.deviceStateStore.read('learning')).toBeNull()
    expect(
      failedInstall.adapter.folders.has(
        'config/plugins/yolo/modules/learning/1.2.3',
      ),
    ).toBe(false)
  })

  it('recovers a prepared transition through the production activation graph', async () => {
    const harness = createHarness()
    await harness.services.manager.refresh()
    const candidate = harness.services.getInstallCandidate('learning')!
    await harness.services.installConfirmedCandidate(candidate)
    const installed = (await harness.deviceStateStore.read('learning'))!
    const target = installed.readyVersions['1.2.3']
    const previousSha256 = await hashModuleTransitionSettingsSnapshot(
      harness.transitionSettingsSnapshot,
      webcrypto.subtle as unknown as Pick<SubtleCrypto, 'digest'>,
    )
    const location = harness.transitionSettingsLocation
    const transition = parseModuleTransitionJournal(
      {
        phase: 'prepared',
        moduleId: 'learning',
        platform: 'desktop',
        previousActiveVersion: null,
        targetVersion: '1.2.3',
        targetManifestSha256: target.manifest.sha256,
        settings: {
          namespace: 'settings',
          location,
          sourceSchemaVersion: 1,
          targetSchemaVersion: 1,
          previous: harness.transitionSettingsSnapshot,
          previousSha256,
          expectedPostSha256: previousSha256,
        },
      },
      {
        moduleId: 'learning',
        platform: 'desktop',
        activeVersion: null,
        downloadedCandidate: null,
        pendingVersion: '1.2.3',
        readyVersions: ['1.2.3'],
        targetDescriptor: target,
      },
    )
    await harness.deviceStateStore.write({
      ...installed,
      downloadedCandidate: null,
      pendingVersion: '1.2.3',
      transition,
    })

    await expect(
      harness.services.activationCoordinator.activatePersistedModules(),
    ).resolves.toEqual([
      { moduleId: 'learning', status: 'activated', version: '1.2.3' },
    ])

    expect(harness.readAtCapturedLocation).toHaveBeenCalledWith(location)
    expect(harness.activationRuntime.activate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'learning' }),
      '1.2.3',
      expect.any(AbortSignal),
    )
    expect(await harness.deviceStateStore.read('learning')).toMatchObject({
      activeVersion: '1.2.3',
      downloadedCandidate: null,
      pendingVersion: null,
      transition: null,
    })
    expect(
      harness.services.activationCoordinator.getStartupDisposition(),
    ).toEqual({ reloadRequired: false, processPoisoned: false })
  })

  it('does not issue candidates while the manager snapshot is loading', async () => {
    const harness = createHarness()
    await harness.services.manager.refresh()
    expect(harness.services.getInstallCandidate('learning')).toBeDefined()

    const refreshing = harness.services.manager.refresh()
    expect(harness.services.manager.getSnapshot().status).toBe('loading')
    expect(harness.services.getInstallCandidate('learning')).toBeUndefined()
    await refreshing
    expect(harness.services.getInstallCandidate('learning')).toBeDefined()
  })

  it('issues a pinned candidate for an available update', async () => {
    const harness = createHarness()
    const oldDescriptor = {
      id: 'learning',
      version: '1.0.0',
      hostApi: '>=1.0.0 <2.0.0',
      dataSchemas: { settings: { readMin: 0, readMax: 1, write: 1 } },
      platform: 'desktop' as const,
      manifestUrl:
        'https://github.com/Lapis0x0/obsidian-yolo/releases/download/module-learning-v1.0.0/module.json',
      manifest: { byteSize: 1, sha256: 'b'.repeat(64) },
    }
    await harness.deviceStateStore.write({
      moduleId: 'learning',
      platform: 'desktop',
      activeVersion: '1.0.0',
      downloadedCandidate: null,
      pendingVersion: null,
      readyVersions: { '1.0.0': oldDescriptor },
      transition: null,
    })

    await harness.services.manager.refresh()
    expect(harness.services.manager.getSnapshot().modules[0]?.status).toBe(
      'update-available',
    )
    expect(harness.services.getInstallCandidate('learning')).toEqual({
      moduleId: 'learning',
      expectedVersion: '1.2.3',
      expectedManifestSha256: sha256(harness.fixture.manifestBytes),
    })
  })

  it.each([
    ['first install', null],
    ['update', '1.0.0'],
  ] as const)(
    'derives and prepares a durable transition after %s',
    async (_label, activeVersion) => {
      const harness = createHarness()
      if (activeVersion) {
        const oldDescriptor = {
          id: 'learning',
          version: activeVersion,
          hostApi: '>=1.0.0 <2.0.0',
          dataSchemas: { settings: { readMin: 0, readMax: 1, write: 1 } },
          platform: 'desktop' as const,
          manifestUrl:
            'https://github.com/Lapis0x0/obsidian-yolo/releases/download/module-learning-v1.0.0/module.json',
          manifest: { byteSize: 1, sha256: 'b'.repeat(64) },
        }
        await harness.deviceStateStore.write({
          moduleId: 'learning',
          platform: 'desktop',
          activeVersion,
          downloadedCandidate: null,
          pendingVersion: null,
          readyVersions: { [activeVersion]: oldDescriptor },
          transition: null,
        })
      }
      await harness.services.manager.refresh()
      const installCandidate = harness.services.getInstallCandidate('learning')!
      await harness.services.installConfirmedCandidate(installCandidate)

      const transitionCandidate =
        await harness.services.getTransitionCandidate('learning')
      expect(transitionCandidate).toEqual(installCandidate)
      expect(Object.isFrozen(transitionCandidate)).toBe(true)

      await harness.services.prepareConfirmedTransition(transitionCandidate!)
      expect(await harness.deviceStateStore.read('learning')).toMatchObject({
        activeVersion,
        downloadedCandidate: null,
        pendingVersion: '1.2.3',
        transition: {
          phase: 'prepared',
          previousActiveVersion: activeVersion,
          targetVersion: '1.2.3',
        },
      })
      expect(
        await harness.services.getTransitionCandidate('learning'),
      ).toBeUndefined()
      await expect(
        harness.services.prepareConfirmedTransition(transitionCandidate!),
      ).rejects.toThrow('already has a transition')
    },
  )

  it('keeps durable transition candidates stable across queries and catalog changes', async () => {
    const harness = createHarness()
    await harness.services.manager.refresh()
    const installCandidate = harness.services.getInstallCandidate('learning')!
    await harness.services.installConfirmedCandidate(installCandidate)

    const first = await harness.services.getTransitionCandidate('learning')
    const second = await harness.services.getTransitionCandidate('learning')
    expect(second).toEqual(first)
    expect(second).not.toBe(first)

    await flushPromises()
    const now = Date.now()
    const clock = jest
      .spyOn(Date, 'now')
      .mockReturnValue(now + OFFICIAL_MODULE_CATALOG_CACHE_TTL_MS + 1)
    harness.catalogRequest.mockResolvedValue(
      response(JSON.stringify({ schemaVersion: 1, modules: [] })),
    )
    try {
      await harness.services.manager.refresh()
    } finally {
      clock.mockRestore()
    }

    expect(await harness.services.getTransitionCandidate('learning')).toEqual(
      first,
    )
  })

  it('rejects duplicate in-flight installs across settings remounts', async () => {
    const fixture = artifact()
    let releaseRequest!: () => void
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve
    })
    const harness = createHarness({
      artifactRequest: async (request) => {
        await requestGate
        if (request.url === fixture.manifestUrl) {
          return response(fixture.manifestBytes)
        }
        if (request.url === fixture.entryUrl) {
          return response(fixture.entryBytes)
        }
        return response('', 404)
      },
    })
    await harness.services.manager.refresh()
    const candidate = harness.services.getInstallCandidate('learning')!

    const firstInstall = harness.services.installConfirmedCandidate(candidate)
    expect(harness.services.getInstallCandidate('learning')).toBeUndefined()
    await expect(
      harness.services.installConfirmedCandidate(candidate),
    ).rejects.toThrow('already in progress')
    await expect(
      harness.services.prepareConfirmedTransition(candidate),
    ).rejects.toThrow('already in progress')

    releaseRequest()
    await firstInstall
    expect(harness.services.getInstallCandidate('learning')).toBeUndefined()
  })

  it('does not retain a failed install as completed', async () => {
    const harness = createHarness({
      artifactRequest: async () => response('', 503),
    })
    await harness.services.manager.refresh()
    const candidate = harness.services.getInstallCandidate('learning')!

    await expect(
      harness.services.installConfirmedCandidate(candidate),
    ).rejects.toThrow('request was not successful')
    expect(harness.services.getInstallCandidate('learning')).toEqual(candidate)
  })

  it('rejects a stale captured candidate after it has completed', async () => {
    const harness = createHarness()
    await harness.services.manager.refresh()
    const candidate = harness.services.getInstallCandidate('learning')!

    await harness.services.installConfirmedCandidate(candidate)
    await expect(
      harness.services.installConfirmedCandidate(candidate),
    ).rejects.toThrow('already downloaded')
    expect(harness.artifactRequest).toHaveBeenCalledTimes(2)
  })

  it('snapshots mutable candidate fields for bookkeeping', async () => {
    const fixture = artifact()
    let releaseRequest!: () => void
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve
    })
    const harness = createHarness({
      artifactRequest: async (request) => {
        await requestGate
        if (request.url === fixture.manifestUrl) {
          return response(fixture.manifestBytes)
        }
        if (request.url === fixture.entryUrl) {
          return response(fixture.entryBytes)
        }
        return response('', 404)
      },
    })
    await harness.services.manager.refresh()
    const issued = harness.services.getInstallCandidate('learning')!
    const mutableCandidate = { ...issued }

    const installation =
      harness.services.installConfirmedCandidate(mutableCandidate)
    mutableCandidate.moduleId = 'calendar'
    mutableCandidate.expectedVersion = '9.9.9'
    mutableCandidate.expectedManifestSha256 = 'f'.repeat(64)
    releaseRequest()

    await expect(installation).resolves.toMatchObject({
      descriptor: { id: 'learning', version: '1.2.3' },
    })
    await expect(
      harness.services.installConfirmedCandidate(issued),
    ).rejects.toThrow('already downloaded')
  })

  it('shares the module exclusion with install and snapshots mutable transition requests', async () => {
    const harness = createHarness()
    await harness.services.manager.refresh()
    const installCandidate = harness.services.getInstallCandidate('learning')!
    await harness.services.coordinator.installConfirmedCandidate(
      installCandidate,
    )
    const issued = await harness.services.getTransitionCandidate('learning')
    let releaseCapture!: () => void
    const captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve
    })
    harness.captureSettings.mockImplementation(async () => {
      await captureGate
      return {
        location: harness.transitionSettingsLocation,
        snapshot: harness.transitionSettingsSnapshot,
      }
    })
    const mutableCandidate = { ...issued! }

    const preparation =
      harness.services.prepareConfirmedTransition(mutableCandidate)
    mutableCandidate.moduleId = 'calendar'
    mutableCandidate.expectedVersion = '9.9.9'
    mutableCandidate.expectedManifestSha256 = 'f'.repeat(64)
    await expect(
      harness.services.installConfirmedCandidate(installCandidate),
    ).rejects.toThrow('already in progress')
    expect(
      await harness.services.getTransitionCandidate('learning'),
    ).toBeUndefined()

    releaseCapture()
    await expect(preparation).resolves.toBeUndefined()
    expect(await harness.deviceStateStore.read('learning')).toMatchObject({
      moduleId: 'learning',
      pendingVersion: '1.2.3',
    })
  })

  it('allows transition preparation to retry after failure', async () => {
    const harness = createHarness()
    await harness.services.manager.refresh()
    await harness.services.installConfirmedCandidate(
      harness.services.getInstallCandidate('learning')!,
    )
    const candidate = await harness.services.getTransitionCandidate('learning')
    harness.captureSettings.mockRejectedValueOnce(new Error('capture failed'))

    await expect(
      harness.services.prepareConfirmedTransition(candidate!),
    ).rejects.toThrow('capture failed')
    await expect(
      harness.services.prepareConfirmedTransition(candidate!),
    ).resolves.toBeUndefined()
    expect(await harness.deviceStateStore.read('learning')).toMatchObject({
      pendingVersion: '1.2.3',
    })
  })

  it('disposes transition preparation and rejects later transition access', async () => {
    const harness = createHarness()
    await harness.services.manager.refresh()
    await harness.services.installConfirmedCandidate(
      harness.services.getInstallCandidate('learning')!,
    )
    const candidate = await harness.services.getTransitionCandidate('learning')
    harness.captureSettings.mockImplementation(() => new Promise(() => {}))
    const preparation = harness.services.prepareConfirmedTransition(candidate!)
    await Promise.resolve()

    harness.services.dispose()

    await expect(preparation).rejects.toThrow(
      'transition coordinator is disposed',
    )
    expect(
      await harness.services.getTransitionCandidate('learning'),
    ).toBeUndefined()
    await expect(
      harness.services.prepareConfirmedTransition(candidate!),
    ).rejects.toThrow('services are disposed')
  })

  it('rejects installs after disposal', async () => {
    const harness = createHarness()
    await harness.services.manager.refresh()
    const candidate = harness.services.getInstallCandidate('learning')!
    harness.services.dispose()

    await expect(
      harness.services.installConfirmedCandidate(candidate),
    ).rejects.toThrow('services are disposed')
    expect(harness.services.getInstallCandidate('learning')).toBeUndefined()
  })

  it('fails closed when compatibility and installation platforms differ', async () => {
    const fixture = artifact()
    const adapter = new MemoryAdapter()
    const dataAdapter = adapter as unknown as DataAdapter
    const store = new ModuleStore({
      adapter: dataAdapter,
      manifest: { id: 'yolo', dir: 'config/plugins/yolo' },
      configDir: 'config',
    })
    const services = createProductionModuleServices({
      store,
      deviceStateStore: new ModuleDeviceStateStore({
        kind: 'device-local-runtime-state',
        adapter,
        rootPath: 'device/module-state',
      }),
      catalogCacheAdapter: new MemoryAdapter(),
      platform: 'mobile',
      getCompatibility: async () => ({
        hostApi: '1.0.0',
        platform: 'desktop',
        dataSchemas: { settings: 0 },
        supportedDataNamespaces: ['settings'],
      }),
      isActive: () => false,
      activationLoader: {
        load: async (entry) => ({
          id: entry.id,
          activate: () => undefined,
        }),
      },
      activationRuntime: { activate: async () => undefined },
      transitionSettingsBackend: {
        capture: async () => ({
          location: {
            moduleId: 'learning',
            storageRoot: 'YOLO/.yolo_json_db/module-settings',
            storagePath: 'YOLO/.yolo_json_db/module-settings/learning.json',
          },
          snapshot: { present: false as const, envelope: null },
        }),
        readAtCapturedLocation: async () => ({
          present: false as const,
          envelope: null,
        }),
      },
      transitionRecoveryRealmToken: {},
      readCurrentSchemaVersion: async () => 0,
      catalogRequest: async () => response(fixture.catalog),
      artifactRequest: async () => response('', 404),
      subtleCrypto: webcrypto.subtle as unknown as SubtleCrypto,
    })

    await services.manager.refresh()
    expect(services.manager.getSnapshot()).toMatchObject({
      status: 'error',
      errors: {
        catalog: expect.stringContaining('does not match mobile'),
      },
    })
  })
})
