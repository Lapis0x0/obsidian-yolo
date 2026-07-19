// eslint-disable-next-line import/no-nodejs-modules -- production composition tests use Node's Web Crypto implementation
import { createHash, webcrypto } from 'node:crypto'

import type { DataAdapter, RequestUrlParam, RequestUrlResponse } from 'obsidian'

import { ModuleDeviceStateStore } from './moduleDeviceStateStore'
import type { ModuleIntent } from './moduleIntentStore'
import { ModuleRuntimeReservation } from './moduleRuntimeReservation'
import { ModuleStore, moduleReadyMarkerFileName } from './moduleStore'
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
    if (text !== undefined)
      return { type: 'file', size: encode(text).byteLength }
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
    return {
      files: [...this.textFiles.keys(), ...this.binaryFiles.keys()].filter(
        (entry) =>
          entry.startsWith(prefix) && !entry.slice(prefix.length).includes('/'),
      ),
      folders: [...this.folders].filter(
        (entry) =>
          entry !== path &&
          entry.startsWith(prefix) &&
          !entry.slice(prefix.length).includes('/'),
      ),
    }
  }

  async rmdir(path: string, recursive: boolean): Promise<void> {
    const prefix = `${path}/`
    const children = [
      ...this.textFiles.keys(),
      ...this.binaryFiles.keys(),
      ...this.folders,
    ].filter((entry) => entry.startsWith(prefix))
    if (!recursive && children.length > 0)
      throw new Error('Folder is not empty')
    for (const entry of children) {
      this.textFiles.delete(entry)
      this.binaryFiles.delete(entry)
      this.folders.delete(entry)
    }
    this.folders.delete(path)
  }

  async rename(from: string, to: string): Promise<void> {
    const prefix = `${from}/`
    for (const [path, value] of [...this.textFiles]) {
      if (path === from || path.startsWith(prefix)) {
        this.textFiles.delete(path)
        this.textFiles.set(`${to}${path.slice(from.length)}`, value)
      }
    }
    for (const [path, value] of [...this.binaryFiles]) {
      if (path === from || path.startsWith(prefix)) {
        this.binaryFiles.delete(path)
        this.binaryFiles.set(`${to}${path.slice(from.length)}`, value)
      }
    }
    for (const path of [...this.folders]) {
      if (path === from || path.startsWith(prefix)) {
        this.folders.delete(path)
        this.folders.add(`${to}${path.slice(from.length)}`)
      }
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

function artifact() {
  const releaseRoot =
    'https://github.com/Lapis0x0/obsidian-yolo/releases/download/module-learning-v1.2.3'
  const entryUrl = `${releaseRoot}/entry.js`
  const manifestUrl = `${releaseRoot}/module.json`
  const entryBytes = encode('globalThis.yoloModuleLoaded = true')
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
          files: [
            {
              role: 'entry',
              name: 'entry.js',
              path: 'entry.js',
              byteSize: entryBytes.byteLength,
              sha256: sha256(entryBytes),
              url: entryUrl,
              storage: 'module',
            },
          ],
        },
      ],
    })}\n`,
  )
  const manifestSha256 = sha256(manifestBytes)
  const readyMarkerBytes = encode(
    `${JSON.stringify({
      schemaVersion: 1,
      id: 'learning',
      version: '1.2.3',
      platform: 'desktop',
      manifestSha256,
    })}\n`,
  )
  const readyMarkerUrl = `${releaseRoot}/${moduleReadyMarkerFileName(
    'desktop',
    manifestSha256,
  )}`
  const catalog = JSON.stringify({
    schemaVersion: 1,
    modules: [
      {
        id: 'learning',
        name: 'Learning',
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
              sha256: manifestSha256,
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
    manifestSha256,
    readyMarkerBytes,
    readyMarkerUrl,
  }
}

function createHarness() {
  const fixture = artifact()
  const adapter = new MemoryAdapter()
  const cacheAdapter = new MemoryAdapter()
  const store = new ModuleStore({
    adapter: adapter as unknown as DataAdapter,
    manifest: { id: 'yolo', dir: 'config/plugins/yolo' },
    configDir: 'config',
  })
  const deviceStateStore = new ModuleDeviceStateStore({
    kind: 'device-local-runtime-state',
    adapter,
    rootPath: 'device/module-state',
  })
  const intents = new Map<string, ModuleIntent>([['learning', 'uninstalled']])
  const listeners = new Set<(moduleId: string) => void>()
  const intentStore = {
    get: jest.fn(async (moduleId: string) => intents.get(moduleId)),
    set: jest.fn(async (moduleId: string, intent: ModuleIntent) => {
      intents.set(moduleId, intent)
      return intent
    }),
    listModuleIds: jest.fn(async () => [...intents.keys()]),
    subscribeAll: jest.fn((listener: (moduleId: string) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
  }
  const activeVersions = new Map<string, string>()
  const runtime = {
    isActive: jest.fn((moduleId: string) => activeVersions.has(moduleId)),
    activate: jest.fn(async (definition: { id: string }, version: string) => {
      activeVersions.set(definition.id, version)
    }),
  }
  const runtimeReservation = new ModuleRuntimeReservation({ runtime })
  const catalogRequest = jest.fn(async () => response(fixture.catalog))
  const artifactRequest = jest.fn(async (request: RequestUrlParam) => {
    if (request.url === fixture.manifestUrl)
      return response(fixture.manifestBytes)
    if (request.url === fixture.entryUrl) return response(fixture.entryBytes)
    if (request.url === fixture.readyMarkerUrl)
      return response(fixture.readyMarkerBytes)
    return response('', 404)
  })
  const isActive = jest.fn(
    (moduleId: string, version: string) =>
      activeVersions.get(moduleId) === version,
  )
  const reportCleanupError = jest.fn()
  const reportRefreshError = jest.fn()
  const services = createProductionModuleServices({
    store,
    deviceStateStore,
    catalogCacheAdapter: cacheAdapter,
    platform: 'desktop',
    getCompatibility: createOfficialModuleCompatibilityProvider({
      platform: 'desktop',
      readDeviceState: async (moduleId) => {
        const state = await deviceStateStore.read(moduleId)
        return state
          ? {
              moduleId,
              platform: state.platform,
              activeVersion: state.active?.version ?? null,
            }
          : null
      },
    }),
    isActive,
    intentStore,
    activationLoader: {
      load: jest.fn(async (entry: { id: string }) => ({
        id: entry.id,
        activate: () => undefined,
      })),
    },
    runtimeReservation,
    catalogRequest,
    artifactRequest,
    authorizeArtifactRemoval: async () => true,
    subtleCrypto: webcrypto.subtle as unknown as SubtleCrypto,
    requestReload: jest.fn(),
    reportCleanupError,
    reportRefreshError,
  })
  return {
    activeVersions,
    adapter,
    deviceStateStore,
    fixture,
    intents,
    intentStore,
    reportCleanupError,
    reportRefreshError,
    services,
  }
}

async function install(harness: ReturnType<typeof createHarness>) {
  await harness.services.refresh()
  const candidate = harness.services.getInstallCandidate('learning')
  if (!candidate) throw new Error('Missing install candidate')
  return harness.services.install(candidate)
}

describe('createProductionModuleServices', () => {
  it('keeps production constants stable', () => {
    expect(OFFICIAL_MODULE_CATALOG_CACHE_PATH).toBe(
      'official-module-catalog/catalog-v1.json',
    )
    expect(OFFICIAL_MODULE_CATALOG_CACHE_TTL_MS).toBe(21_600_000)
    expect(OFFICIAL_MODULE_CATALOG_TIMEOUT_MS).toBe(10_000)
    expect(OFFICIAL_MODULE_ARTIFACT_TIMEOUT_MS).toBe(30_000)
  })

  it('exposes only the module facade and Learning composition seam', () => {
    const { services } = createHarness()

    expect(Object.keys(services).sort()).toEqual(
      [
        'dispose',
        'getInstallCandidate',
        'getSnapshot',
        'getVerifiedArtifact',
        'install',
        'learningDataRemovalDependencies',
        'refresh',
        'setEnabled',
        'start',
        'subscribe',
        'uninstall',
      ].sort(),
    )
  })

  it('installs the exact candidate, schedules it, and enables intent', async () => {
    const harness = createHarness()

    await expect(install(harness)).resolves.toEqual({
      reloadRequired: true,
      version: '1.2.3',
    })
    expect(harness.intents.get('learning')).toBe('enabled')
    expect(await harness.deviceStateStore.read('learning')).toMatchObject({
      pending: {
        descriptor: { version: '1.2.3' },
      },
    })
    expect(harness.services.getInstallCandidate('learning')).toBeUndefined()
  })

  it('cancels only the matching pending pointer when intent persistence fails', async () => {
    const harness = createHarness()
    await harness.services.refresh()
    const candidate = harness.services.getInstallCandidate('learning')!
    const intentError = new Error('intent write failed')
    harness.intentStore.set.mockRejectedValueOnce(intentError)

    await expect(harness.services.install(candidate)).rejects.toBe(intentError)
    const state = await harness.deviceStateStore.read('learning')
    expect(state).toMatchObject({
      active: null,
      pending: null,
    })
  })

  it('delegates enablement to synchronized intent', async () => {
    const harness = createHarness()
    harness.intents.set('learning', 'disabled')

    await expect(
      harness.services.setEnabled('learning', true),
    ).resolves.toEqual({ reloadRequired: true })
    expect(harness.intents.get('learning')).toBe('enabled')
  })

  it('clears intent and safely removes an inactive pending installation', async () => {
    const harness = createHarness()
    await install(harness)

    await expect(harness.services.uninstall('learning')).resolves.toEqual({
      reloadRequired: false,
    })
    expect(harness.intents.get('learning')).toBe('uninstalled')
    expect(await harness.deviceStateStore.read('learning')).toBeNull()
  })

  it('keeps active artifacts until reload after uninstall intent', async () => {
    const harness = createHarness()
    await install(harness)
    const pending = (await harness.deviceStateStore.read('learning'))!
    await harness.deviceStateStore.write({
      ...pending,
      active: pending.pending!.descriptor,
      pending: null,
    })
    harness.activeVersions.set('learning', '1.2.3')

    await expect(harness.services.uninstall('learning')).resolves.toEqual({
      reloadRequired: true,
    })
    expect(await harness.deviceStateStore.read('learning')).not.toBeNull()
  })

  it('starts reconciliation and refreshes the snapshot', async () => {
    const harness = createHarness()

    await expect(harness.services.start()).resolves.toBeUndefined()
    expect(harness.services.getSnapshot().status).toBe('ready')
  })

  it('activates a pending target and commits it as active', async () => {
    const harness = createHarness()
    await install(harness)

    await harness.services.start()

    expect(harness.activeVersions.get('learning')).toBe('1.2.3')
    expect(await harness.deviceStateStore.read('learning')).toMatchObject({
      active: { version: '1.2.3' },
      pending: null,
    })
  })
})
