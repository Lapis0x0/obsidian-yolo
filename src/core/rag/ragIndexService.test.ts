import { BackgroundActivityRegistry } from '../background/backgroundActivityRegistry'

import { RagIndexBusyError, RagIndexService } from './ragIndexService'

const waitForNextTick = async () =>
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('RagIndexService', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('restores an interrupted rebuild as a sync resume', async () => {
    // Even when the prior run was a rebuild, recovery downgrades to sync so the
    // reconcile loop skips chunks already in the DB instead of truncating.
    // Users who really want a fresh rebuild trigger it explicitly from the UI.
    const saved: Record<string, string> = {
      yolo_rag_index_run: JSON.stringify({
        runId: 'old-run',
        status: 'running',
        mode: 'rebuild',
        trigger: 'manual',
        retryPolicy: 'transient',
        completedFiles: 30,
        totalFiles: 200,
        completedChunks: 600,
        totalChunks: 4000,
      }),
    }

    const service = new RagIndexService({
      app: {
        loadLocalStorage: jest.fn((key: string) => saved[key] ?? null),
        saveLocalStorage: jest.fn((key: string, value: string) => {
          saved[key] = value
        }),
      } as never,
      getRagEngine: jest.fn(),
      activityRegistry: new BackgroundActivityRegistry(),
      isRagEnabled: () => true,
      t: (_key, fallback) => fallback ?? '',
    })

    await service.initialize()

    expect(service.getSnapshot()).toMatchObject({
      status: 'retry_scheduled',
      failureKind: 'transient',
      retryPolicy: 'transient',
      mode: 'sync',
      trigger: 'manual',
      // Progress is preserved so the UI can show "已索引 X / Y".
      completedFiles: 30,
      totalFiles: 200,
      completedChunks: 600,
      totalChunks: 4000,
    })
  })

  it('restores an interrupted sync as sync (idempotent)', async () => {
    const saved: Record<string, string> = {
      yolo_rag_index_run: JSON.stringify({
        runId: 'old-run',
        status: 'running',
        mode: 'sync',
        trigger: 'auto',
        retryPolicy: 'transient',
      }),
    }

    const service = new RagIndexService({
      app: {
        loadLocalStorage: jest.fn((key: string) => saved[key] ?? null),
        saveLocalStorage: jest.fn((key: string, value: string) => {
          saved[key] = value
        }),
      } as never,
      getRagEngine: jest.fn(),
      activityRegistry: new BackgroundActivityRegistry(),
      isRagEnabled: () => true,
      t: (_key, fallback) => fallback ?? '',
    })

    await service.initialize()

    expect(service.getSnapshot()).toMatchObject({
      status: 'retry_scheduled',
      mode: 'sync',
      trigger: 'auto',
    })
  })

  it('restores interrupted non-retryable runs as failed on initialize', async () => {
    const saved: Record<string, string> = {
      yolo_rag_index_run: JSON.stringify({
        runId: 'old-run',
        status: 'running',
        mode: 'sync',
        trigger: 'manual',
        retryPolicy: 'none',
      }),
    }

    const service = new RagIndexService({
      app: {
        loadLocalStorage: jest.fn((key: string) => saved[key] ?? null),
        saveLocalStorage: jest.fn((key: string, value: string) => {
          saved[key] = value
        }),
      } as never,
      getRagEngine: jest.fn(),
      activityRegistry: new BackgroundActivityRegistry(),
      isRagEnabled: () => true,
      t: (_key, fallback) => fallback ?? '',
    })

    await service.initialize()

    expect(service.getSnapshot()).toMatchObject({
      status: 'failed',
      failureKind: 'unknown',
      retryPolicy: 'none',
    })
  })

  it('publishes progress and blocks concurrent runs', async () => {
    let resolveRun: () => void = () => undefined
    const updateVaultIndex = jest.fn().mockImplementation(
      async (
        _options: unknown,
        onProgress?: (progress: {
          type: 'indexing'
          indexProgress: {
            completedChunks: number
            totalChunks: number
            totalFiles: number
            completedFiles: number
            currentFile: string
          }
        }) => void,
      ) => {
        onProgress?.({
          type: 'indexing',
          indexProgress: {
            completedChunks: 1,
            totalChunks: 2,
            totalFiles: 1,
            completedFiles: 0,
            currentFile: 'foo.md',
          },
        })
        await new Promise<void>((resolve) => {
          resolveRun = resolve
        })
        return { permanentFailedPaths: [], chunkifyFailedPaths: [] }
      },
    )
    const service = new RagIndexService({
      app: {
        loadLocalStorage: jest.fn().mockReturnValue(null),
        saveLocalStorage: jest.fn(),
      } as never,
      getRagEngine: jest.fn().mockResolvedValue({ updateVaultIndex }),
      activityRegistry: new BackgroundActivityRegistry(),
      isRagEnabled: () => true,
      t: (_key, fallback) => fallback ?? '',
    })

    await service.initialize()
    const firstRun = service.runIndex({
      mode: 'sync',
      scope: { kind: 'all' },
      trigger: 'manual',
      retryPolicy: 'none',
    })

    await waitForNextTick()
    expect(service.getSnapshot()).toMatchObject({
      status: 'running',
      currentFile: 'foo.md',
      completedChunks: 1,
      retryPolicy: 'none',
    })

    await expect(
      service.runIndex({
        mode: 'sync',
        scope: { kind: 'all' },
        trigger: 'manual',
        retryPolicy: 'none',
      }),
    ).rejects.toBeInstanceOf(RagIndexBusyError)

    resolveRun()
    await firstRun

    expect(service.getSnapshot()).toMatchObject({
      status: 'completed',
    })
  })

  it('schedules retry for transient manual rebuild failures', async () => {
    jest.useFakeTimers()
    const updateVaultIndex = jest
      .fn()
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce({
        permanentFailedPaths: [],
        chunkifyFailedPaths: [],
      })
    const service = new RagIndexService({
      app: {
        loadLocalStorage: jest.fn().mockReturnValue(null),
        saveLocalStorage: jest.fn(),
      } as never,
      getRagEngine: jest.fn().mockResolvedValue({ updateVaultIndex }),
      activityRegistry: new BackgroundActivityRegistry(),
      isRagEnabled: () => true,
      t: (_key, fallback) => fallback ?? '',
    })

    await service.initialize()

    await expect(
      service.runIndex({
        mode: 'rebuild',
        scope: { kind: 'all' },
        trigger: 'manual',
        retryPolicy: 'transient',
      }),
    ).rejects.toThrow('network timeout')

    expect(service.getSnapshot()).toMatchObject({
      status: 'retry_scheduled',
      retryPolicy: 'transient',
      mode: 'rebuild',
    })

    await jest.advanceTimersByTimeAsync(5 * 60_000)

    expect(updateVaultIndex).toHaveBeenCalledTimes(2)
    expect(service.getSnapshot()).toMatchObject({
      status: 'completed',
    })
  })

  it('does not schedule retry for permanent manual failures', async () => {
    const permanentError = Object.assign(new Error('invalid api key'), {
      status: 401,
    })
    const updateVaultIndex = jest.fn().mockRejectedValue(permanentError)
    const service = new RagIndexService({
      app: {
        loadLocalStorage: jest.fn().mockReturnValue(null),
        saveLocalStorage: jest.fn(),
      } as never,
      getRagEngine: jest.fn().mockResolvedValue({ updateVaultIndex }),
      activityRegistry: new BackgroundActivityRegistry(),
      isRagEnabled: () => true,
      t: (_key, fallback) => fallback ?? '',
    })

    await service.initialize()

    await expect(
      service.runIndex({
        mode: 'rebuild',
        scope: { kind: 'all' },
        trigger: 'manual',
        retryPolicy: 'transient',
      }),
    ).rejects.toThrow('invalid api key')

    expect(service.getSnapshot()).toMatchObject({
      status: 'failed',
      failureKind: 'permanent',
      retryPolicy: 'transient',
    })
  })

  it('restores scheduled manual retries', async () => {
    jest.useFakeTimers()
    const updateVaultIndex = jest
      .fn()
      .mockResolvedValue({ permanentFailedPaths: [], chunkifyFailedPaths: [] })
    const service = new RagIndexService({
      app: {
        loadLocalStorage: jest.fn().mockReturnValue(
          JSON.stringify({
            runId: 'retry-run',
            status: 'retry_scheduled',
            mode: 'rebuild',
            trigger: 'manual',
            retryPolicy: 'transient',
            retryAt: Date.now() + 1_000,
          }),
        ),
        saveLocalStorage: jest.fn(),
      } as never,
      getRagEngine: jest.fn().mockResolvedValue({ updateVaultIndex }),
      activityRegistry: new BackgroundActivityRegistry(),
      isRagEnabled: () => true,
      t: (_key, fallback) => fallback ?? '',
    })

    await service.initialize()
    service.restoreRetryScheduledRun()
    await jest.advanceTimersByTimeAsync(1_000)

    expect(updateVaultIndex).toHaveBeenCalledTimes(1)
    expect(service.getSnapshot()).toMatchObject({
      status: 'completed',
    })
  })

  it('persists permanentFailedPaths on a completed run and returns the result', async () => {
    const updateVaultIndex = jest.fn().mockResolvedValue({
      permanentFailedPaths: ['bad.md', 'broken.md'],
      chunkifyFailedPaths: ['transient.md'],
    })
    const service = new RagIndexService({
      app: {
        loadLocalStorage: jest.fn().mockReturnValue(null),
        saveLocalStorage: jest.fn(),
      } as never,
      getRagEngine: jest.fn().mockResolvedValue({ updateVaultIndex }),
      activityRegistry: new BackgroundActivityRegistry(),
      isRagEnabled: () => true,
      t: (_key, fallback) => fallback ?? '',
    })

    await service.initialize()
    const result = await service.runIndex({
      mode: 'sync',
      scope: { kind: 'all' },
      trigger: 'auto',
      retryPolicy: 'transient',
    })

    // runIndex returns the reconcile result for the manual-path Notice.
    expect(result).toEqual({
      permanentFailedPaths: ['bad.md', 'broken.md'],
      chunkifyFailedPaths: ['transient.md'],
    })
    expect(service.getSnapshot()).toMatchObject({
      status: 'completed',
      // Permanent failures persist; chunkify failures (self-healing) do not.
      permanentFailedPaths: ['bad.md', 'broken.md'],
    })
  })

  it('clears permanentFailedPaths on a clean completion', async () => {
    const updateVaultIndex = jest
      .fn()
      .mockResolvedValueOnce({
        permanentFailedPaths: ['bad.md'],
        chunkifyFailedPaths: [],
      })
      .mockResolvedValueOnce({
        permanentFailedPaths: [],
        chunkifyFailedPaths: [],
      })
    const service = new RagIndexService({
      app: {
        loadLocalStorage: jest.fn().mockReturnValue(null),
        saveLocalStorage: jest.fn(),
      } as never,
      getRagEngine: jest.fn().mockResolvedValue({ updateVaultIndex }),
      activityRegistry: new BackgroundActivityRegistry(),
      isRagEnabled: () => true,
      t: (_key, fallback) => fallback ?? '',
    })

    await service.initialize()
    await service.runIndex({
      mode: 'sync',
      scope: { kind: 'all' },
      trigger: 'auto',
      retryPolicy: 'transient',
    })
    expect(service.getSnapshot().permanentFailedPaths).toEqual(['bad.md'])

    await service.runIndex({
      mode: 'sync',
      scope: { kind: 'all' },
      trigger: 'auto',
      retryPolicy: 'transient',
    })
    expect(service.getSnapshot().permanentFailedPaths).toBeUndefined()
  })
})
