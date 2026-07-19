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
  pending: ModuleDeviceState['pending'] = null,
): ModuleDeviceState {
  return {
    moduleId: 'learning',
    platform: 'desktop',
    active: descriptor('1.0.0'),
    pending,
  }
}

function pending(activationStarted: boolean): ModuleDeviceState['pending'] {
  return { descriptor: descriptor('2.0.0'), activationStarted }
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

describe('ModuleDeviceStateStore', () => {
  test('persists only active and pending descriptors', async () => {
    const { adapter, store } = harness()
    await store.write(state(pending(false)))

    expect(await store.read('learning')).toEqual(state(pending(false)))
    const envelope = JSON.parse(adapter.files.get(PATH)!)
    expect(envelope.schemaVersion).toBe(1)
    expect(envelope.data).toEqual(state(pending(false)))
  })

  test('enforces pending -> activation-started -> active progression', async () => {
    const { store } = harness()
    await store.write(state(pending(false)))
    await store.write(state(pending(true)))
    await expect(store.write(state(pending(false)))).rejects.toThrow(
      'Pending activation progression is invalid',
    )
    await store.write({
      ...state(),
      active: descriptor('2.0.0'),
    })

    expect(await store.read('learning')).toEqual({
      ...state(),
      active: descriptor('2.0.0'),
    })
  })

  test('allows clearing a pending activation before or after activation starts', async () => {
    const beforeActivation = harness().store
    await beforeActivation.write(state(pending(false)))
    await beforeActivation.write(state())

    const afterActivation = harness().store
    await afterActivation.write(state(pending(false)))
    await afterActivation.write(state(pending(true)))
    await afterActivation.write(state())
  })

  test('rejects starting activation in a newly created state', async () => {
    const { store } = harness()
    await expect(store.write(state(pending(true)))).rejects.toThrow(
      'A new pending activation must begin in pending',
    )
  })

  test('does not interpret development-time legacy schemas', async () => {
    const { adapter, store } = harness()
    adapter.folders.add(ROOT)
    adapter.files.set(
      PATH,
      JSON.stringify({
        schemaVersion: 3,
        data: {
          moduleId: 'learning',
          platform: 'desktop',
          activeVersion: '1.0.0',
          pendingVersion: null,
          activationPhase: null,
          readyVersions: { '1.0.0': descriptor('1.0.0') },
        },
      }),
    )

    await expect(store.read('learning')).rejects.toThrow(
      'unsupported schema version 3',
    )
  })

  test('rejects active and pending descriptors for the same version', async () => {
    const { store } = harness()
    await expect(
      store.write(
        state({
          descriptor: descriptor('1.0.0'),
          activationStarted: false,
        }),
      ),
    ).rejects.toThrow('Pending version must differ from active version')
  })
})
