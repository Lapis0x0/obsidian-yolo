import { FileSystemAdapter } from 'obsidian'

import type { LocalEmbeddingCatalogEntry } from './catalog'
import { downloadFileResumable } from './download'
import { LocalEmbeddingModelManager } from './manager'

jest.mock('./download', () => ({
  downloadFileResumable: jest.fn(),
  DownloadVerificationError: class DownloadVerificationError extends Error {},
}))

const mockDownload = downloadFileResumable as jest.MockedFunction<
  typeof downloadFileResumable
>

type FakeStat = { isFile: () => boolean; size: number }

function createFakeFs() {
  const files = new Map<string, string>()
  const rmCalls: string[] = []
  return {
    files,
    rmCalls,
    promises: {
      mkdir: jest.fn().mockResolvedValue(undefined),
      writeFile: jest.fn(async (path: string, data: string) => {
        files.set(path, data)
      }),
      readFile: jest.fn(async (path: string) => {
        const content = files.get(path)
        if (content === undefined) {
          const error = new Error('ENOENT') as NodeJS.ErrnoException
          error.code = 'ENOENT'
          throw error
        }
        return content
      }),
      stat: jest.fn(async (path: string): Promise<FakeStat> => {
        const content = files.get(path)
        if (content === undefined) {
          const error = new Error('ENOENT') as NodeJS.ErrnoException
          error.code = 'ENOENT'
          throw error
        }
        return { isFile: () => true, size: Number(content) }
      }),
      rm: jest.fn(async (path: string) => {
        rmCalls.push(path)
        for (const key of [...files.keys()]) {
          if (key === path || key.startsWith(`${path}/`)) files.delete(key)
        }
      }),
    },
  }
}

let fakeFs: ReturnType<typeof createFakeFs>

jest.mock('node:fs', () => ({
  get promises() {
    return fakeFs.promises
  },
}))

// Single file keeps the state-machine assertions below simple: one
// `downloadFileResumable` call maps 1:1 to one `manager.download()` call.
// `PLUGIN_PREFIX` mirrors what `resolveModulePluginDir({id:'yolo'}, '.config')`
// really returns, so manually-seeded fake-fs paths in the scan test line up
// with what the manager itself computes.
const PLUGIN_PREFIX = '/vault/.config/plugins/yolo'

const ENTRY: LocalEmbeddingCatalogEntry = {
  id: 'test-model',
  hfRepo: 'Xenova/test-model',
  revision: 'a'.repeat(40),
  displayName: 'Test Model',
  languages: ['en'],
  license: 'MIT',
  dimension: 8,
  maxTokens: 128,
  pooling: 'mean',
  normalize: true,
  files: [{ path: 'config.json', byteSize: 4, sha256: 'x'.repeat(64) }],
  totalBytes: 4,
}

function createAdapter(): FileSystemAdapter {
  const adapter = new FileSystemAdapter()
  Object.assign(adapter, {
    getFullPath: (path: string) => `/vault/${path}`,
  })
  return adapter
}

const SECOND_ENTRY: LocalEmbeddingCatalogEntry = {
  ...ENTRY,
  id: 'second-model',
  hfRepo: 'Xenova/second-model',
}

function createManager(overrides?: { endpoint?: string }) {
  return new LocalEmbeddingModelManager({
    adapter: createAdapter(),
    manifest: { id: 'yolo' },
    configDir: '.config',
    getEndpoint: () => overrides?.endpoint ?? 'https://huggingface.co',
    catalog: [ENTRY, SECOND_ENTRY],
  })
}

describe('LocalEmbeddingModelManager', () => {
  beforeEach(() => {
    fakeFs = createFakeFs()
    mockDownload.mockReset()
    mockDownload.mockImplementation(async ({ destPath, expectedByteSize }) => {
      fakeFs.files.set(destPath, String(expectedByteSize))
    })
  })

  it('starts every catalog entry as not-installed', () => {
    const manager = createManager()
    expect(manager.getState('test-model')).toEqual({ status: 'not-installed' })
  })

  it('download() drives the state machine through downloading -> verifying -> ready and writes a manifest', async () => {
    const manager = createManager()
    const states: string[] = []
    manager.subscribe(() => states.push(manager.getState('test-model').status))

    await manager.download(ENTRY)

    expect(manager.getState('test-model')).toEqual({ status: 'ready' })
    expect(states).toEqual(
      expect.arrayContaining(['downloading', 'verifying', 'ready']),
    )
    expect(mockDownload).toHaveBeenCalledTimes(1)
    expect(fakeFs.promises.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('manifest.json'),
      expect.stringContaining('"catalogId": "test-model"'),
      'utf8',
    )
  })

  it('download() requests each file from `${endpoint}/${hfRepo}/resolve/${revision}/${path}`', async () => {
    const manager = createManager({ endpoint: 'https://hf-mirror.com/' })
    await manager.download(ENTRY)

    expect(mockDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `https://hf-mirror.com/${ENTRY.hfRepo}/resolve/${ENTRY.revision}/config.json`,
      }),
    )
  })

  it('a failed download transitions to failed{error} and rejects', async () => {
    const manager = createManager()
    mockDownload.mockRejectedValueOnce(new Error('sha mismatch'))

    await expect(manager.download(ENTRY)).rejects.toThrow('sha mismatch')
    expect(manager.getState('test-model')).toEqual({
      status: 'failed',
      error: 'sha mismatch',
    })
  })

  it('cancelDownload aborts the in-flight download and resets to not-installed', async () => {
    const manager = createManager()
    let capturedSignal: AbortSignal | undefined
    let started: () => void = () => undefined
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })
    mockDownload.mockImplementationOnce(async ({ signal }) => {
      capturedSignal = signal
      started()
      await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () =>
          reject(new DOMException('Download aborted', 'AbortError')),
        )
      })
    })

    const downloadPromise = manager.download(ENTRY)
    await startedPromise
    manager.cancelDownload('test-model')
    await downloadPromise

    expect(capturedSignal?.aborted).toBe(true)
    expect(manager.getState('test-model')).toEqual({ status: 'not-installed' })
  })

  it('caps concurrency at 1 across different entries: the second download() waits for the first to finish', async () => {
    const manager = createManager()
    const order: string[] = []
    let resolveFirst: () => void = () => undefined
    const firstStarted = new Promise<void>((resolveStarted) => {
      mockDownload.mockImplementationOnce(async () => {
        order.push('first-start')
        resolveStarted()
        await new Promise<void>((resolve) => {
          resolveFirst = resolve
        })
        order.push('first-end')
        fakeFs.files.set(
          `${PLUGIN_PREFIX}/runtime/embedding-models/test-model/${ENTRY.revision}/config.json`,
          '4',
        )
      })
    })
    mockDownload.mockImplementationOnce(
      async ({ destPath, expectedByteSize }) => {
        order.push('second')
        fakeFs.files.set(destPath, String(expectedByteSize))
      },
    )

    const first = manager.download(ENTRY)
    await firstStarted
    const second = manager.download(SECOND_ENTRY)
    // The second download must not have started yet — it's queued behind
    // the first, not running concurrently.
    expect(order).toEqual(['first-start'])

    resolveFirst()
    await Promise.all([first, second])

    expect(order).toEqual(['first-start', 'first-end', 'second'])
  })

  it('remove() deletes the model directory and resets state to not-installed', async () => {
    const manager = createManager()
    await manager.download(ENTRY)
    expect(manager.getState('test-model')).toEqual({ status: 'ready' })

    await manager.remove('test-model')

    expect(manager.getState('test-model')).toEqual({ status: 'not-installed' })
    expect(fakeFs.rmCalls.length).toBeGreaterThan(0)
  })

  it('scanInstalled() marks an entry ready when its manifest and files already exist on disk, without downloading', async () => {
    const manager = createManager()
    const dir = `${PLUGIN_PREFIX}/runtime/embedding-models/test-model/${ENTRY.revision}`
    fakeFs.files.set(
      `${dir}/manifest.json`,
      JSON.stringify({ catalogId: 'test-model', revision: ENTRY.revision }),
    )
    fakeFs.files.set(`${dir}/config.json`, '4')

    await manager.scanInstalled()

    expect(manager.getState('test-model')).toEqual({ status: 'ready' })
    expect(mockDownload).not.toHaveBeenCalled()
  })

  it('readModelFile throws when the model is not ready', async () => {
    const manager = createManager()
    await expect(manager.readModelFile(ENTRY, 'config.json')).rejects.toThrow(
      /not installed/,
    )
  })

  it("readModelFile rejects a path that is not one of the entry's declared files", async () => {
    const manager = createManager()
    await manager.download(ENTRY)
    await expect(
      manager.readModelFile(ENTRY, '../../../etc/passwd'),
    ).rejects.toThrow(/not a declared file/)
  })

  it('getSnapshot() returns a new Map reference on every state change (useSyncExternalStore correctness)', async () => {
    const manager = createManager()
    const snapshots: ReadonlyMap<string, unknown>[] = [manager.getSnapshot()]
    manager.subscribe(() => snapshots.push(manager.getSnapshot()))

    await manager.download(ENTRY)

    // download() alone drives multiple setState calls (downloading ->
    // verifying -> ready); every one of them must be a distinct Map
    // reference, not the same Map mutated in place, or `useSyncExternalStore`
    // subscribers in the P3 UI never re-render.
    expect(snapshots.length).toBeGreaterThan(1)
    expect(new Set(snapshots).size).toBe(snapshots.length)
  })

  it('download() called again for an entry that is still queued returns the same job instead of enqueueing a second one', async () => {
    const manager = createManager()
    let resolveFirst: () => void = () => undefined
    const firstStarted = new Promise<void>((resolveStarted) => {
      mockDownload.mockImplementationOnce(
        async ({ destPath, expectedByteSize }) => {
          resolveStarted()
          await new Promise<void>((resolve) => {
            resolveFirst = resolve
          })
          fakeFs.files.set(destPath, String(expectedByteSize))
        },
      )
    })
    let secondEntryCallCount = 0
    mockDownload.mockImplementation(async ({ destPath, expectedByteSize }) => {
      secondEntryCallCount += 1
      fakeFs.files.set(destPath, String(expectedByteSize))
    })

    const first = manager.download(ENTRY)
    await firstStarted
    // Both calls target SECOND_ENTRY while it's still queued behind ENTRY —
    // must dedupe to the same job rather than queuing two runs of it.
    const secondA = manager.download(SECOND_ENTRY)
    const secondB = manager.download(SECOND_ENTRY)
    expect(secondA).toBe(secondB)

    resolveFirst()
    await Promise.all([first, secondA, secondB])

    expect(secondEntryCallCount).toBe(1)
    expect(manager.getState('second-model')).toEqual({ status: 'ready' })
  })

  it('remove() aborts an in-flight download and waits for it to settle before touching disk', async () => {
    const manager = createManager()
    const order: string[] = []
    let started: () => void = () => undefined
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })
    mockDownload.mockImplementationOnce(async ({ signal }) => {
      started()
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          // Real `downloadFileResumable` doesn't settle synchronously on
          // abort — `writeStream.destroy()` and friends still run first.
          // Delaying by a microtask makes this test meaningful: it fails
          // against the pre-fix `remove()`, which called `rm()` right after
          // `cancelDownload()` without waiting for the job to settle.
          queueMicrotask(() => {
            order.push('download-settled')
            reject(new DOMException('Download aborted', 'AbortError'))
          })
        })
      })
    })
    const originalRm = fakeFs.promises.rm.getMockImplementation()!
    fakeFs.promises.rm.mockImplementation(async (...args) => {
      order.push('rm-called')
      return originalRm(...args)
    })

    const downloadPromise = manager.download(ENTRY)
    await startedPromise
    await manager.remove('test-model')
    await downloadPromise

    expect(order).toEqual(['download-settled', 'rm-called'])
  })

  it('dispose() aborts every job and waits for all of them to settle', async () => {
    const manager = createManager()
    let started: () => void = () => undefined
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })
    let settled = false
    mockDownload.mockImplementationOnce(async ({ signal }) => {
      started()
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          queueMicrotask(() => {
            settled = true
            reject(new DOMException('Download aborted', 'AbortError'))
          })
        })
      })
    })

    const downloadPromise = manager.download(ENTRY)
    await startedPromise
    await manager.dispose()

    expect(settled).toBe(true)
    await downloadPromise
  })

  it('download() for an entry mid-removal waits for rm() to finish before writing files', async () => {
    const manager = createManager()
    await manager.download(ENTRY)
    expect(manager.getState('test-model')).toEqual({ status: 'ready' })

    const order: string[] = []
    let resolveRm: () => void = () => undefined
    const rmStarted = new Promise<void>((resolveStarted) => {
      const originalRm = fakeFs.promises.rm.getMockImplementation()!
      fakeFs.promises.rm.mockImplementationOnce(async (...args) => {
        order.push('rm-start')
        resolveStarted()
        await new Promise<void>((resolve) => {
          resolveRm = resolve
        })
        const result = await originalRm(...args)
        order.push('rm-end')
        return result
      })
    })
    mockDownload.mockImplementationOnce(
      async ({ destPath, expectedByteSize }) => {
        order.push('redownload')
        fakeFs.files.set(destPath, String(expectedByteSize))
      },
    )

    const removePromise = manager.remove('test-model')
    await rmStarted
    // Fires while `rm()` is still pending — must not start writing files
    // until the removal it raced against has fully settled.
    const redownloadPromise = manager.download(ENTRY)
    // Give any wrongly-unguarded microtask a chance to run before releasing
    // the removal.
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(['rm-start'])

    resolveRm()
    await removePromise
    await redownloadPromise

    expect(order).toEqual(['rm-start', 'rm-end', 'redownload'])
    expect(manager.getState('test-model')).toEqual({ status: 'ready' })
  })

  it('a download queued behind another shows status downloading immediately, and reverts to not-installed if cancelled before its turn', async () => {
    const manager = createManager()
    let resolveFirst: () => void = () => undefined
    const firstStarted = new Promise<void>((resolveStarted) => {
      mockDownload.mockImplementationOnce(
        async ({ destPath, expectedByteSize }) => {
          resolveStarted()
          await new Promise<void>((resolve) => {
            resolveFirst = resolve
          })
          fakeFs.files.set(destPath, String(expectedByteSize))
        },
      )
    })

    const first = manager.download(ENTRY)
    await firstStarted
    const second = manager.download(SECOND_ENTRY)

    // Queued, not yet running — but already visible as downloading rather
    // than the misleading `not-installed`.
    expect(manager.getState('second-model')).toEqual({
      status: 'downloading',
      receivedBytes: 0,
      totalBytes: SECOND_ENTRY.totalBytes,
      currentFile: '',
    })

    manager.cancelDownload('second-model')
    resolveFirst()
    await first
    await second

    expect(manager.getState('second-model')).toEqual({
      status: 'not-installed',
    })
    expect(mockDownload).toHaveBeenCalledTimes(1)
  })
})
