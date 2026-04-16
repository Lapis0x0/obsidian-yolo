import { BackgroundActivityRegistry } from '../background/backgroundActivityRegistry'

import { RagIndexBusyError, RagIndexService } from './ragIndexService'

const waitForNextTick = async () =>
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('RagIndexService', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('restores interrupted transient runs as retry scheduled on initialize', async () => {
    const saved: Record<string, string> = {
      smtcmp_rag_index_run: JSON.stringify({
        runId: 'old-run',
        status: 'running',
        mode: 'full',
        trigger: 'manual',
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
      failureKind: 'transient',
      retryPolicy: 'transient',
      mode: 'full',
      trigger: 'manual',
    })
  })

  it('restores interrupted non-retryable runs as failed on initialize', async () => {
    const saved: Record<string, string> = {
      smtcmp_rag_index_run: JSON.stringify({
        runId: 'old-run',
        status: 'running',
        mode: 'incremental',
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
      reindexAll: false,
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
        reindexAll: false,
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

  it('schedules retry for transient manual full rebuild failures', async () => {
    jest.useFakeTimers()
    const updateVaultIndex = jest
      .fn()
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce(undefined)
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
        reindexAll: true,
        trigger: 'manual',
        retryPolicy: 'transient',
      }),
    ).rejects.toThrow('network timeout')

    expect(service.getSnapshot()).toMatchObject({
      status: 'retry_scheduled',
      retryPolicy: 'transient',
      mode: 'full',
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
        reindexAll: true,
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
    const updateVaultIndex = jest.fn().mockResolvedValue(undefined)
    const service = new RagIndexService({
      app: {
        loadLocalStorage: jest.fn().mockReturnValue(
          JSON.stringify({
            runId: 'retry-run',
            status: 'retry_scheduled',
            mode: 'full',
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

  it('preserves resumable full rebuild cursor after a successful incremental run', async () => {
    const updateVaultIndex = jest.fn().mockResolvedValue(undefined)
    const service = new RagIndexService({
      app: {
        loadLocalStorage: jest.fn().mockReturnValue(
          JSON.stringify({
            runId: 'failed-full-run',
            status: 'failed',
            mode: 'full',
            trigger: 'manual',
            retryPolicy: 'transient',
            stagingRunId: 'failed-full-run-staging',
            stagingConfigFingerprint: 'embed-a|1000',
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

    await service.runIndex({
      reindexAll: false,
      trigger: 'manual',
      retryPolicy: 'none',
    })

    expect(service.getSnapshot()).toMatchObject({
      status: 'completed',
      mode: 'incremental',
      stagingRunId: 'failed-full-run-staging',
      stagingConfigFingerprint: 'embed-a|1000',
    })
  })
})
