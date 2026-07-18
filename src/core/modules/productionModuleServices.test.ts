// eslint-disable-next-line import/no-nodejs-modules -- production composition tests use Node's Web Crypto implementation
import { createHash, webcrypto } from 'node:crypto'

import type { DataAdapter, RequestUrlParam, RequestUrlResponse } from 'obsidian'

import { ModuleDeviceStateStore } from './moduleDeviceStateStore'
import { ModuleStore } from './moduleStore'
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
  return { catalog, entryBytes, entryUrl, manifestBytes, manifestUrl }
}

function createHarness(
  overrides: {
    catalogRequest?: (request: RequestUrlParam) => Promise<RequestUrlResponse>
    artifactRequest?: (request: RequestUrlParam) => Promise<RequestUrlResponse>
  } = {},
) {
  const fixture = artifact()
  const adapter = new MemoryAdapter()
  const cacheAdapter = new MemoryAdapter()
  const dataAdapter = adapter as unknown as DataAdapter
  const store = new ModuleStore({
    adapter: dataAdapter,
    manifest: { id: 'yolo', dir: 'plugin' },
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
        return response('', 404)
      }),
  )
  const isActive = jest.fn(() => true)
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
    catalogRequest,
    artifactRequest,
    subtleCrypto: webcrypto.subtle as unknown as SubtleCrypto,
  })
  return {
    adapter,
    artifactRequest,
    cacheAdapter,
    catalogRequest,
    deviceStateStore,
    fixture,
    isActive,
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
    const harness = createHarness()

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
    ])
    expect(
      harness.adapter.binaryFiles.has('plugin/modules/learning/1.2.3/entry.js'),
    ).toBe(true)
    expect(await harness.deviceStateStore.read('learning')).toMatchObject({
      moduleId: 'learning',
      platform: 'desktop',
      activeVersion: null,
      downloadedCandidate: '1.2.3',
    })
    expect(harness.services.manager.getSnapshot().modules[0]?.status).toBe(
      'installed',
    )

    const installed = (await harness.deviceStateStore.read('learning'))!
    await harness.deviceStateStore.write({
      ...installed,
      activeVersion: '1.2.3',
    })
    await harness.services.manager.refresh()
    expect(harness.isActive).toHaveBeenCalledWith('learning', '1.2.3')
    expect(harness.services.manager.getSnapshot().modules[0]?.status).toBe(
      'active',
    )

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
      failedInstall.adapter.folders.has('plugin/modules/learning/1.2.3'),
    ).toBe(false)
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
      manifest: { id: 'yolo', dir: 'plugin' },
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
