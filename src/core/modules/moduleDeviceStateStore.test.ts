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

function pending(version = '2.0.0'): ModuleDeviceState['pending'] {
  return { descriptor: descriptor(version) }
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
    await store.write(state(pending()))

    expect(await store.read('learning')).toEqual(state(pending()))
    const envelope = JSON.parse(adapter.files.get(PATH)!)
    expect(envelope.schemaVersion).toBe(1)
    expect(envelope.data).toEqual(state(pending()))
  })

  test('allows replacing and promoting a pending descriptor', async () => {
    const { store } = harness()
    await store.write(state(pending()))
    await store.write(state(pending('3.0.0')))
    await store.write({
      ...state(),
      active: descriptor('3.0.0'),
    })

    expect(await store.read('learning')).toEqual({
      ...state(),
      active: descriptor('3.0.0'),
    })
  })

  test('allows clearing a pending descriptor', async () => {
    const { store } = harness()
    await store.write(state(pending()))
    await store.write(state())
    expect((await store.read('learning'))?.pending).toBeNull()
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

  test('allows a rebuilt descriptor with the same semantic version', async () => {
    const { store } = harness()
    await store.write(state(pending('1.0.0')))
    expect((await store.read('learning'))?.pending?.descriptor.version).toBe(
      '1.0.0',
    )
  })
})
