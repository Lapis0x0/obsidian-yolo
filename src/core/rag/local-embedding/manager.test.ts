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
})
