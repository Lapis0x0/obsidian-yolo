import type { DataAdapter } from 'obsidian'

import {
  MODULE_ARTIFACT_ARRIVAL_GRACE_MS,
  ModuleArtifactArrivalGrace,
} from './moduleArtifactArrivalGrace'

const ROOT = 'config/plugins/yolo/modules/learning/1.0.0'

describe('ModuleArtifactArrivalGrace', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('adopts a synchronized artifact after its target tree becomes quiet', async () => {
    jest.useFakeTimers()
    const adapter = new FingerprintAdapter()
    let ready = false
    const isReady = jest.fn(async () => ready)
    const grace = createGrace(adapter)

    const waiting = grace.waitForArtifact(
      'learning',
      '1.0.0',
      isReady,
      new AbortController().signal,
    )
    await flushPromises()
    expect(isReady).toHaveBeenCalledTimes(1)

    adapter.addFile(`${ROOT}/entry.js`, 100, 1)
    ready = true
    await jest.advanceTimersByTimeAsync(3_999)
    expect(isReady).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(1)

    await expect(waiting).resolves.toBe(true)
    expect(isReady).toHaveBeenCalledTimes(2)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('performs one final verification at the 20 second limit', async () => {
    jest.useFakeTimers()
    const adapter = new FingerprintAdapter()
    const isReady = jest.fn(async () => false)
    const waiting = createGrace(adapter).waitForArtifact(
      'learning',
      '1.0.0',
      isReady,
      new AbortController().signal,
    )
    await flushPromises()

    await jest.advanceTimersByTimeAsync(MODULE_ARTIFACT_ARRIVAL_GRACE_MS)

    await expect(waiting).resolves.toBe(false)
    expect(isReady).toHaveBeenCalledTimes(2)
  })

  it('ends immediately when background reconciliation is cancelled', async () => {
    jest.useFakeTimers()
    const controller = new AbortController()
    const waiting = createGrace(new FingerprintAdapter()).waitForArtifact(
      'learning',
      '1.0.0',
      async () => false,
      controller.signal,
    )
    controller.abort()

    await expect(waiting).resolves.toBe(false)
    expect(jest.getTimerCount()).toBe(0)
  })
})

function createGrace(adapter: FingerprintAdapter): ModuleArtifactArrivalGrace {
  return new ModuleArtifactArrivalGrace({
    adapter: adapter as unknown as Pick<DataAdapter, 'list' | 'stat'>,
    pluginDir: 'config/plugins/yolo',
  })
}

class FingerprintAdapter {
  private readonly files = new Map<
    string,
    Readonly<{ size: number; mtime: number }>
  >()
  private readonly folders = new Set<string>()

  addFile(path: string, size: number, mtime: number): void {
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index += 1) {
      this.folders.add(parts.slice(0, index).join('/'))
    }
    this.files.set(path, { size, mtime })
  }

  async stat(path: string) {
    const file = this.files.get(path)
    if (file) return { type: 'file' as const, ctime: 0, ...file }
    if (this.folders.has(path)) {
      return { type: 'folder' as const, ctime: 0, mtime: 0, size: 0 }
    }
    return null
  }

  async list(path: string) {
    const prefix = `${path}/`
    return {
      files: [...this.files.keys()].filter(
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
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
