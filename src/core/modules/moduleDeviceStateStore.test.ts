import type { ModuleArtifactDescriptor } from './moduleArtifactVerifier'
import {
  type ModuleDeviceState,
  ModuleDeviceStateStore,
} from './moduleDeviceStateStore'

class MemoryAdapter {
  readonly files = new Map<string, string>()
  readonly folders = new Set<string>()
  async exists(path: string) {
    return this.files.has(path) || this.folders.has(path)
  }
  async stat(path: string) {
    if (this.files.has(path)) return { type: 'file' as const }
    if (this.folders.has(path)) return { type: 'folder' as const }
    return null
  }
  async mkdir(path: string) {
    this.folders.add(path)
  }
  async read(path: string) {
    const value = this.files.get(path)
    if (value === undefined) throw new Error('missing')
    return value
  }
  async write(path: string, data: string) {
    this.files.set(path, data)
  }
  async remove(path: string) {
    this.files.delete(path)
  }
  async list(path: string) {
    const prefix = `${path}/`
    return {
      files: [...this.files.keys()].filter((entry) => entry.startsWith(prefix)),
      folders: [],
    }
  }
}

const ROOT = 'device/module-state'
const PATH = `${ROOT}/learning.json`
const HASH = 'a'.repeat(64)

function descriptor(version: string): ModuleArtifactDescriptor {
  return {
    id: 'learning',
    version,
    hostApi: '^1.0.0',
    dataSchemas: { settings: { readMin: 0, readMax: 2, write: 2 } },
    platform: 'desktop',
    manifestUrl: `https://github.com/Lapis0x0/obsidian-yolo/releases/download/learning-v${version}/module.json`,
    manifest: { byteSize: 42, sha256: HASH },
  }
}

function state(
  phase: ModuleDeviceState['activationPhase'] = null,
): ModuleDeviceState {
  return {
    moduleId: 'learning',
    platform: 'desktop',
    activeVersion: '1.0.0',
    pendingVersion: phase === null ? null : '2.0.0',
    activationPhase: phase,
    readyVersions: {
      '1.0.0': descriptor('1.0.0'),
      '2.0.0': descriptor('2.0.0'),
    },
  }
}

function harness() {
  const adapter = new MemoryAdapter()
  const store = new ModuleDeviceStateStore({
    kind: 'device-local-runtime-state',
    adapter,
    rootPath: ROOT,
  })
  return { adapter, store }
}

describe('ModuleDeviceStateStore v3', () => {
  test('persists the minimal pending activation state', async () => {
    const { adapter, store } = harness()
    await store.write(state('pending'))
    expect(await store.read('learning')).toEqual(state('pending'))
    expect(JSON.parse(adapter.files.get(PATH)!).schemaVersion).toBe(3)
  })

  test('enforces pending -> activation-started -> active progression', async () => {
    const { store } = harness()
    await store.write(state('pending'))
    await store.write(state('activation-started'))
    await expect(store.write(state('pending'))).rejects.toThrow(
      'Pending activation progression is invalid',
    )
    await store.write({
      ...state('activation-started'),
      activeVersion: '2.0.0',
      pendingVersion: null,
      activationPhase: null,
    })
  })

  test('migrates v1 pending and discards a downloaded-only pointer', async () => {
    const { adapter, store } = harness()
    adapter.folders.add(ROOT)
    adapter.files.set(
      PATH,
      JSON.stringify({
        schemaVersion: 1,
        data: {
          moduleId: 'learning',
          platform: 'desktop',
          activeVersion: '1.0.0',
          downloadedCandidate: '2.0.0',
          pendingVersion: null,
          readyVersions: state().readyVersions,
        },
      }),
    )
    expect(await store.read('learning')).toMatchObject({
      activeVersion: '1.0.0',
      pendingVersion: null,
      activationPhase: null,
    })

    adapter.files.set(
      PATH,
      JSON.stringify({
        schemaVersion: 1,
        data: {
          moduleId: 'learning',
          platform: 'desktop',
          activeVersion: '1.0.0',
          downloadedCandidate: null,
          pendingVersion: '2.0.0',
          readyVersions: state().readyVersions,
        },
      }),
    )
    expect(await store.read('learning')).toMatchObject({
      pendingVersion: '2.0.0',
      activationPhase: 'pending',
    })
  })

  test.each([
    ['prepared', 'pending', '2.0.0'],
    ['settings-committed', 'pending', '2.0.0'],
    ['activation-started', 'activation-started', '2.0.0'],
    ['committed', null, null],
    ['rollback-completed', null, null],
  ] as const)('migrates v2 phase %s', async (legacyPhase, phase, pending) => {
    const { adapter, store } = harness()
    adapter.folders.add(ROOT)
    const activeVersion = legacyPhase === 'committed' ? '2.0.0' : '1.0.0'
    adapter.files.set(
      PATH,
      JSON.stringify({
        schemaVersion: 2,
        data: {
          moduleId: 'learning',
          platform: 'desktop',
          activeVersion,
          downloadedCandidate:
            legacyPhase === 'rollback-completed' ? '2.0.0' : null,
          pendingVersion: [
            'prepared',
            'settings-committed',
            'activation-started',
          ].includes(legacyPhase)
            ? '2.0.0'
            : null,
          readyVersions: state().readyVersions,
          transition: {
            phase: legacyPhase,
            moduleId: 'learning',
            platform: 'desktop',
            previousActiveVersion: '1.0.0',
            targetVersion: '2.0.0',
            targetManifestSha256: HASH,
            settings: null,
          },
        },
      }),
    )
    expect(await store.read('learning')).toMatchObject({
      activeVersion,
      pendingVersion: pending,
      activationPhase: phase,
    })
  })
})
