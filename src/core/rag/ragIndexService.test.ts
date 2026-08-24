import { BackgroundActivityRegistry } from '../background/backgroundActivityRegistry'

import { RagIndexService } from './ragIndexService'

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
      yolo_rag_index_runs: JSON.stringify({
        'kb-a': {
          runId: 'old-run',
          status: 'running',
          mode: 'rebuild',
          trigger: 'manual',
          retryPolicy: 'transient',
          completedFiles: 30,
          totalFiles: 200,
          completedChunks: 600,
          totalChunks: 4000,
        },
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

    expect(service.getRunSnapshot('kb-a')).toMatchObject({
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
      yolo_rag_index_runs: JSON.stringify({
        'kb-a': {
          runId: 'old-run',
          status: 'running',
          mode: 'sync',
          trigger: 'auto',
          retryPolicy: 'transient',
        },
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

    expect(service.getRunSnapshot('kb-a')).toMatchObject({
      status: 'retry_scheduled',
      mode: 'sync',
      trigger: 'auto',
    })
  })

  it('restores interrupted non-retryable runs as failed on initialize', async () => {
    const saved: Record<string, string> = {
      yolo_rag_index_runs: JSON.stringify({
        'kb-a': {
          runId: 'old-run',
          status: 'running',
          mode: 'sync',
          trigger: 'manual',
          retryPolicy: 'none',
        },
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

    expect(service.getRunSnapshot('kb-a')).toMatchObject({
      status: 'failed',
      failureKind: 'unknown',
      retryPolicy: 'none',
    })
  })

  it('publishes progress while running, then completes', async () => {
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
    const firstRun = service.run('kb-a', {
      mode: 'sync',
      scope: { kind: 'all' },
      trigger: 'manual',
      retryPolicy: 'none',
    })

    await waitForNextTick()
    expect(service.getRunSnapshot('kb-a')).toMatchObject({
      status: 'running',
      currentFile: 'foo.md',
      completedChunks: 1,
      retryPolicy: 'none',
    })
    expect(service.getSnapshot().activeKbId).toBe('kb-a')

    resolveRun()
    await firstRun

    expect(service.getRunSnapshot('kb-a')).toMatchObject({
      status: 'completed',
    })
    expect(service.getSnapshot().activeKbId).toBeNull()
  })

  it('queues a second knowledge base behind the active run and runs it next (FIFO)', async () => {
    const resolvers = new Map<string, () => void>()
    const updateVaultIndex = jest
      .fn()
      .mockImplementation(async (_options: unknown) => {
        // The kbId isn't visible to updateVaultIndex itself; rely on call
        // order instead — first call is kb-a, second is kb-b.
        const kbId = updateVaultIndex.mock.calls.length === 1 ? 'kb-a' : 'kb-b'
        await new Promise<void>((resolve) => {
          resolvers.set(kbId, resolve)
        })
        return { permanentFailedPaths: [], chunkifyFailedPaths: [] }
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
    const runA = service.run('kb-a', {
      mode: 'sync',
      scope: { kind: 'all' },
      trigger: 'manual',
      retryPolicy: 'none',
    })
    const runB = service.run('kb-b', {
      mode: 'sync',
      scope: { kind: 'all' },
      trigger: 'manual',
      retryPolicy: 'none',
    })

    await waitForNextTick()
    // Only kb-a is active; kb-b sits in the queue rather than running
    // concurrently or being rejected as "busy".
    expect(service.getSnapshot().activeKbId).toBe('kb-a')
    expect(service.getSnapshot().queuedKbIds).toEqual(['kb-b'])
    expect(service.getRunSnapshot('kb-b').status).toBe('queued')
    expect(updateVaultIndex).toHaveBeenCalledTimes(1)

    resolvers.get('kb-a')?.()
    await runA
    await waitForNextTick()

    expect(service.getSnapshot().activeKbId).toBe('kb-b')
    expect(service.getSnapshot().queuedKbIds).toEqual([])
    expect(updateVaultIndex).toHaveBeenCalledTimes(2)

    resolvers.get('kb-b')?.()
    await runB

    expect(service.getRunSnapshot('kb-a').status).toBe('completed')
    expect(service.getRunSnapshot('kb-b').status).toBe('completed')
  })

  it('merges a second request for an already-queued base instead of running it twice', async () => {
    // Reassigned on every call — kb-a's run and kb-b's merged run share this
    // one mocked engine, so each must be resolved individually, in order.
    let resolveCurrent: () => void = () => undefined
    const updateVaultIndex = jest.fn().mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        resolveCurrent = resolve
      })
      return { permanentFailedPaths: [], chunkifyFailedPaths: [] }
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
    void service.run('kb-a', {
      mode: 'sync',
      scope: { kind: 'all' },
      trigger: 'auto',
      retryPolicy: 'none',
    })
    await waitForNextTick()

    // kb-b queued twice with different scopes before it ever runs — these
    // must merge into a single queued entry, not two separate runs.
    const runB1 = service.run('kb-b', {
      mode: 'sync',
      scope: { kind: 'paths', paths: ['a.md'] },
      trigger: 'auto',
      retryPolicy: 'none',
    })
    const runB2 = service.run('kb-b', {
      mode: 'rebuild',
      scope: { kind: 'paths', paths: ['b.md'] },
      trigger: 'manual',
      retryPolicy: 'transient',
    })
    // run() awaits initialize() before it enqueues anything, so the queue
    // registration itself only lands after a tick.
    await waitForNextTick()

    expect(service.getSnapshot().queuedKbIds).toEqual(['kb-b'])

    // Resolve kb-a's run, letting kb-b's merged run start next.
    resolveCurrent()
    await waitForNextTick()
    await waitForNextTick()

    // The merged run absorbed rebuild (rebuild absorbs sync) and both waiters
    // resolve off the single merged run.
    expect(updateVaultIndex).toHaveBeenCalledTimes(2)

    // Resolve kb-b's run too — `updateVaultIndex` is shared across both
    // knowledge bases in this mock, so `resolveCurrent` now points at kb-b's
    // in-flight call.
    resolveCurrent()
    await Promise.all([runB1, runB2])
    expect(service.getRunSnapshot('kb-b').mode).toBe('rebuild')
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
      service.run('kb-a', {
        mode: 'rebuild',
        scope: { kind: 'all' },
        trigger: 'manual',
        retryPolicy: 'transient',
      }),
    ).rejects.toThrow('network timeout')

    expect(service.getRunSnapshot('kb-a')).toMatchObject({
      status: 'retry_scheduled',
      retryPolicy: 'transient',
      mode: 'rebuild',
    })

    await jest.advanceTimersByTimeAsync(5 * 60_000)

    expect(updateVaultIndex).toHaveBeenCalledTimes(2)
    expect(service.getRunSnapshot('kb-a')).toMatchObject({
      status: 'completed',
    })
  })

  it('stops a manual run after three automatic retries', async () => {
    jest.useFakeTimers()
    const updateVaultIndex = jest
      .fn()
      .mockRejectedValue(new Error('network timeout'))
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
      service.run('kb-a', {
        mode: 'sync',
        scope: { kind: 'all' },
        trigger: 'manual',
        retryPolicy: 'transient',
      }),
    ).rejects.toThrow('network timeout')

    await jest.advanceTimersByTimeAsync(5 * 60_000)
    await jest.advanceTimersByTimeAsync(15 * 60_000)
    await jest.advanceTimersByTimeAsync(30 * 60_000)

    expect(updateVaultIndex).toHaveBeenCalledTimes(4)
    expect(service.getRunSnapshot('kb-a')).toMatchObject({
      status: 'failed',
      retryCount: 3,
    })
    await jest.advanceTimersByTimeAsync(60 * 60_000)
    expect(updateVaultIndex).toHaveBeenCalledTimes(4)
  })

  it('brings a pending manual retry forward on reconnect without resetting its budget', async () => {
    jest.useFakeTimers()
    const updateVaultIndex = jest
      .fn()
      .mockRejectedValue(new Error('network timeout'))
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
      service.run('kb-a', {
        mode: 'sync',
        scope: { kind: 'all' },
        trigger: 'manual',
        retryPolicy: 'transient',
      }),
    ).rejects.toThrow('network timeout')
    expect(service.getRunSnapshot('kb-a')).toMatchObject({ retryCount: 1 })

    service.onOnline()
    await jest.advanceTimersByTimeAsync(0)

    expect(updateVaultIndex).toHaveBeenCalledTimes(2)
    expect(service.getRunSnapshot('kb-a')).toMatchObject({
      status: 'retry_scheduled',
      retryCount: 2,
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
      service.run('kb-a', {
        mode: 'rebuild',
        scope: { kind: 'all' },
        trigger: 'manual',
        retryPolicy: 'transient',
      }),
    ).rejects.toThrow('invalid api key')

    expect(service.getRunSnapshot('kb-a')).toMatchObject({
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
            'kb-a': {
              runId: 'retry-run',
              status: 'retry_scheduled',
              mode: 'rebuild',
              trigger: 'manual',
              retryPolicy: 'transient',
              retryAt: Date.now() + 1_000,
            },
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
    service.restoreRetryScheduledRun('kb-a')
    await jest.advanceTimersByTimeAsync(1_000)

    expect(updateVaultIndex).toHaveBeenCalledTimes(1)
    expect(service.getRunSnapshot('kb-a')).toMatchObject({
      status: 'completed',
    })
  })

  it('resets an exhausted retry episode only on explicit reset', async () => {
    const saved: Record<string, string> = {
      yolo_rag_index_runs: JSON.stringify({
        'kb-a': {
          runId: 'failed-run',
          status: 'failed',
          mode: 'sync',
          trigger: 'auto',
          retryPolicy: 'transient',
          retryCount: 3,
          failureKind: 'transient',
          failureMessage: 'network timeout',
        },
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
    expect(service.getRunSnapshot('kb-a')).toMatchObject({
      status: 'failed',
      retryCount: 3,
    })

    await service.resetRetryState('kb-a')
    expect(service.getRunSnapshot('kb-a')).toMatchObject({
      status: 'idle',
      retryPolicy: 'none',
      retryCount: 0,
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
    const result = await service.run('kb-a', {
      mode: 'sync',
      scope: { kind: 'all' },
      trigger: 'auto',
      retryPolicy: 'transient',
    })

    // run() returns the reconcile result for the manual-path Notice.
    expect(result).toEqual({
      permanentFailedPaths: ['bad.md', 'broken.md'],
      chunkifyFailedPaths: ['transient.md'],
    })
    expect(service.getRunSnapshot('kb-a')).toMatchObject({
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
    await service.run('kb-a', {
      mode: 'sync',
      scope: { kind: 'all' },
      trigger: 'auto',
      retryPolicy: 'transient',
    })
    expect(service.getRunSnapshot('kb-a').permanentFailedPaths).toEqual([
      'bad.md',
    ])

    await service.run('kb-a', {
      mode: 'sync',
      scope: { kind: 'all' },
      trigger: 'auto',
      retryPolicy: 'transient',
    })
    expect(service.getRunSnapshot('kb-a').permanentFailedPaths).toBeUndefined()
  })

  it('forgetKnowledgeBase cancels a queued run and drops its snapshot', async () => {
    let resolveA: () => void = () => undefined
    const updateVaultIndex = jest.fn().mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        resolveA = resolve
      })
      return { permanentFailedPaths: [], chunkifyFailedPaths: [] }
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
    void service.run('kb-a', {
      mode: 'sync',
      scope: { kind: 'all' },
      trigger: 'auto',
      retryPolicy: 'none',
    })
    await waitForNextTick()

    const runB = service.run('kb-b', {
      mode: 'sync',
      scope: { kind: 'all' },
      trigger: 'auto',
      retryPolicy: 'none',
    })
    // run() awaits initialize() before it enqueues anything, so the queue
    // registration itself only lands after a tick.
    await waitForNextTick()
    expect(service.getSnapshot().queuedKbIds).toEqual(['kb-b'])

    await service.forgetKnowledgeBase('kb-b')
    await expect(runB).rejects.toThrow()
    expect(service.getSnapshot().queuedKbIds).toEqual([])
    expect(service.getSnapshot().runs).not.toHaveProperty('kb-b')

    resolveA()
  })

  it('does not resolve a same-kb follow-up run when the active run for that kb completes', async () => {
    // Regression for waiters previously bucketed by kbId alone: a second
    // run() against an already-active base must become a follow-up run with
    // its own waiter, not resolve off the in-flight run's completion.
    const resolvers: Array<() => void> = []
    const updateVaultIndex = jest.fn().mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        resolvers.push(resolve)
      })
      return { permanentFailedPaths: [], chunkifyFailedPaths: [] }
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
    const runA1 = service.run('kb-a', {
      mode: 'sync',
      scope: { kind: 'all' },
      trigger: 'auto',
      retryPolicy: 'none',
    })
    await waitForNextTick()
    expect(service.getSnapshot().activeKbId).toBe('kb-a')

    const runA2 = service.run('kb-a', {
      mode: 'sync',
      scope: { kind: 'all' },
      trigger: 'auto',
      retryPolicy: 'none',
    })
    await waitForNextTick()
    expect(service.getSnapshot().queuedKbIds).toEqual(['kb-a'])

    resolvers[0]()
    await runA1
    await waitForNextTick()

    // The follow-up run has started (second call), but must not have
    // resolved off the first run's completion.
    expect(updateVaultIndex).toHaveBeenCalledTimes(2)
    const pendingSentinel = Symbol('pending')
    const raceResult = await Promise.race([
      runA2,
      new Promise((resolve) => setTimeout(() => resolve(pendingSentinel), 10)),
    ])
    expect(raceResult).toBe(pendingSentinel)

    resolvers[1]()
    await expect(runA2).resolves.toEqual({
      permanentFailedPaths: [],
      chunkifyFailedPaths: [],
    })
  })

  it('cancelAndWait cancels both the active run and its own queued follow-up', async () => {
    const updateVaultIndex = jest.fn().mockImplementation(
      async ({ signal }: { signal?: AbortSignal }) =>
        await new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        }),
    )
    const service = new RagIndexService({
      app: {
        loadLocalStorage: jest.fn().mockReturnValue(null),
        saveLocalStorage: jest.fn(),
      } as never,
      getRagEngine: jest.fn().mockResolvedValue({
        updateVaultIndex,
        releaseEmbeddingIdleSession: jest.fn(),
      }),
      activityRegistry: new BackgroundActivityRegistry(),
      isRagEnabled: () => true,
      t: (_key, fallback) => fallback ?? '',
    })

    await service.initialize()
    const runA1 = service.run('kb-a', {
      mode: 'sync',
      scope: { kind: 'all' },
      trigger: 'auto',
      retryPolicy: 'none',
    })
    await waitForNextTick()
    const runA2 = service.run('kb-a', {
      mode: 'sync',
      scope: { kind: 'all' },
      trigger: 'auto',
      retryPolicy: 'none',
    })
    await waitForNextTick()
    expect(service.getSnapshot().activeKbId).toBe('kb-a')
    expect(service.getSnapshot().queuedKbIds).toEqual(['kb-a'])

    await service.cancelAndWait('kb-a')

    await expect(runA1).rejects.toBeTruthy()
    await expect(runA2).rejects.toBeTruthy()
    expect(service.getSnapshot().activeKbId).toBeNull()
    expect(service.getSnapshot().queuedKbIds).toEqual([])
  })
})
