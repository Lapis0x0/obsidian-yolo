jest.mock('obsidian', () => ({
  TAbstractFile: class {},
  TFile: class {},
  TFolder: class {},
  normalizePath: (path: string) => path,
}))

import type { YoloSettings } from '../../settings/schema/setting.types'

import { RagAutoUpdateService } from './ragAutoUpdateService'

describe('RagAutoUpdateService', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  const flushAsync = async () => {
    await Promise.resolve()
    await Promise.resolve()
  }

  const createService = () => {
    const settings = {
      embeddingModelId: 'test-embed',
      embeddingModels: [{ id: 'test-embed' }],
      ragOptions: {
        enabled: true,
        autoUpdateEnabled: true,
        lastAutoUpdateAt: 0,
        indexPdf: true,
      },
      knowledgeBases: [
        { id: 'kb-a', name: 'kb-a', description: '', include: [], exclude: [] },
      ],
    } as unknown as YoloSettings
    let retryCount = 0
    const runIndex = jest.fn().mockImplementation(async () => {
      retryCount = 0
    })
    const setSettings = jest.fn().mockResolvedValue(undefined)
    const markRetryScheduled = jest
      .fn()
      .mockImplementation(
        async (_kbId: string, { retryCount: nextRetryCount }) => {
          retryCount = nextRetryCount
        },
      )
    const clearRetryScheduled = jest.fn().mockResolvedValue(undefined)

    const service = new RagAutoUpdateService({
      getSettings: () => settings,
      setSettings,
      runIndex,
      getRetryCount: () => retryCount,
      markRetryScheduled,
      clearRetryScheduled,
    })

    return {
      service,
      settings,
      runIndex,
      setSettings,
      markRetryScheduled,
      clearRetryScheduled,
      setRetryCount: (value: number) => {
        retryCount = value
      },
      cleanup: () => undefined,
    }
  }

  it('waits for five minutes of idle time before running auto update', async () => {
    const { service, runIndex, cleanup } = createService()

    service.onVaultPathChanged('foo.md')
    jest.advanceTimersByTime(299_000)
    await flushAsync()

    expect(runIndex).not.toHaveBeenCalled()

    jest.advanceTimersByTime(1_000)
    await flushAsync()

    expect(runIndex).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('coalesces repeated edits into a single auto update run', async () => {
    const { service, runIndex, cleanup } = createService()

    service.onVaultPathChanged('foo.md')
    jest.advanceTimersByTime(30_000)
    service.onVaultPathChanged('foo.md')
    jest.advanceTimersByTime(299_000)
    await flushAsync()

    expect(runIndex).not.toHaveBeenCalled()

    jest.advanceTimersByTime(1_000)
    await flushAsync()

    expect(runIndex).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('does not run when knowledge base indexing is disabled', async () => {
    const { service, settings, runIndex, cleanup } = createService()

    settings.ragOptions.enabled = false
    service.onVaultPathChanged('foo.md')
    jest.advanceTimersByTime(5 * 60_000)
    await flushAsync()

    expect(runIndex).not.toHaveBeenCalled()
    cleanup()
  })

  it('does not run when auto update is disabled', async () => {
    const { service, settings, runIndex, cleanup } = createService()

    settings.ragOptions.autoUpdateEnabled = false
    service.onVaultPathChanged('foo.md')
    jest.advanceTimersByTime(5 * 60_000)
    await flushAsync()

    expect(runIndex).not.toHaveBeenCalled()
    cleanup()
  })

  it('does not schedule updates for non-markdown paths', async () => {
    const { service, runIndex, cleanup } = createService()

    service.onVaultPathChanged('foo.png')
    jest.advanceTimersByTime(5 * 60_000)
    await flushAsync()

    expect(runIndex).not.toHaveBeenCalled()
    cleanup()
  })

  it('tracks and flushes two differently-scoped knowledge bases independently', async () => {
    // Each knowledge base gets its own RagAutoUpdateWorker keyed by kbId — a
    // path that only matches one base's include/exclude scope must dirty
    // (and later flush) only that base's worker, never the other's.
    const settings = {
      embeddingModelId: 'test-embed',
      embeddingModels: [{ id: 'test-embed' }],
      ragOptions: {
        enabled: true,
        autoUpdateEnabled: true,
        lastAutoUpdateAt: 0,
        indexPdf: true,
      },
      knowledgeBases: [
        {
          id: 'kb-a',
          name: 'kb-a',
          description: '',
          include: ['FolderA'],
          exclude: [],
        },
        {
          id: 'kb-b',
          name: 'kb-b',
          description: '',
          include: ['FolderB'],
          exclude: [],
        },
      ],
    } as unknown as YoloSettings
    const retryCounts = new Map<string, number>()
    const runIndex = jest.fn().mockResolvedValue(undefined)
    const setSettings = jest.fn().mockResolvedValue(undefined)
    const markRetryScheduled = jest.fn().mockResolvedValue(undefined)
    const clearRetryScheduled = jest.fn().mockResolvedValue(undefined)

    const service = new RagAutoUpdateService({
      getSettings: () => settings,
      setSettings,
      runIndex,
      getRetryCount: (kbId: string) => retryCounts.get(kbId) ?? 0,
      markRetryScheduled,
      clearRetryScheduled,
    })

    // Only kb-a's scope matches this path — kb-b's worker must stay idle.
    service.onVaultPathChanged('FolderA/note.md')
    jest.advanceTimersByTime(5 * 60_000)
    await flushAsync()

    expect(runIndex).toHaveBeenCalledTimes(1)
    expect(runIndex).toHaveBeenCalledWith('kb-a', {
      kind: 'paths',
      paths: ['FolderA/note.md'],
    })

    runIndex.mockClear()

    // Now a path only kb-b's scope matches — must flush kb-b alone.
    service.onVaultPathChanged('FolderB/note.md')
    jest.advanceTimersByTime(5 * 60_000)
    await flushAsync()

    expect(runIndex).toHaveBeenCalledTimes(1)
    expect(runIndex).toHaveBeenCalledWith('kb-b', {
      kind: 'paths',
      paths: ['FolderB/note.md'],
    })

    service.cleanup()
  })

  it('runs sooner when the window blurs after a short grace period', async () => {
    const { service, runIndex, cleanup } = createService()

    service.onVaultPathChanged('foo.md')
    jest.advanceTimersByTime(15_000)
    service.onWindowBlur()
    jest.advanceTimersByTime(0)
    await flushAsync()

    expect(runIndex).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('restores dirty paths and schedules retry after transient failure', async () => {
    const transientError = new Error('network timeout')
    const {
      service,
      runIndex,
      markRetryScheduled,
      clearRetryScheduled,
      cleanup,
    } = createService()
    runIndex
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce(undefined)

    service.onVaultPathChanged('foo.md')
    jest.advanceTimersByTime(5 * 60_000)
    await flushAsync()

    expect(runIndex).toHaveBeenCalledTimes(1)
    expect(clearRetryScheduled).toHaveBeenCalledTimes(1)
    expect(markRetryScheduled).toHaveBeenCalledTimes(1)

    jest.advanceTimersByTime(5 * 60_000)
    await flushAsync()

    expect(runIndex).toHaveBeenCalledTimes(2)
    cleanup()
  })

  it('restores persisted retry schedule on startup', async () => {
    const { service, runIndex, cleanup } = createService()

    service.restoreRetryScheduled('kb-a', Date.now() + 5 * 60_000)
    jest.advanceTimersByTime(5 * 60_000)
    await flushAsync()

    expect(runIndex).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('does not keep retrying after permanent failure', async () => {
    const permanentError = Object.assign(new Error('invalid api key'), {
      status: 401,
    })
    const {
      service,
      runIndex,
      markRetryScheduled,
      clearRetryScheduled,
      cleanup,
    } = createService()
    runIndex.mockRejectedValueOnce(permanentError)

    service.onVaultPathChanged('foo.md')
    jest.advanceTimersByTime(5 * 60_000)
    await flushAsync()

    expect(runIndex).toHaveBeenCalledTimes(1)
    expect(clearRetryScheduled).toHaveBeenCalledTimes(1)
    expect(markRetryScheduled).not.toHaveBeenCalled()

    jest.advanceTimersByTime(10 * 60_000)
    await flushAsync()

    expect(runIndex).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('stops after three automatic retries', async () => {
    const transientError = new Error('network timeout')
    const { service, runIndex, markRetryScheduled, cleanup } = createService()
    // Always fail transiently.
    runIndex.mockRejectedValue(transientError)

    service.onVaultPathChanged('foo.md')

    const expectedDelaysMs = [
      5 * 60_000, // 5m
      15 * 60_000, // 15m
      30 * 60_000, // 30m
    ]

    // Advance by the EDIT_IDLE_WINDOW first to trigger the initial run.
    jest.advanceTimersByTime(5 * 60_000)
    await flushAsync()

    for (let i = 0; i < expectedDelaysMs.length; i += 1) {
      const before = Date.now()
      const lastCall = markRetryScheduled.mock.calls.at(-1)?.[1] as {
        retryAt: number
      }
      const observedDelay = lastCall.retryAt - before
      // retryAt is computed as Date.now() + delay during the failure handler,
      // which runs synchronously within the just-fired run, so before≈that now.
      expect(observedDelay).toBe(expectedDelaysMs[i])
      // Fire the next retry.
      jest.advanceTimersByTime(expectedDelaysMs[i])
      await flushAsync()
    }

    expect(runIndex).toHaveBeenCalledTimes(4)
    expect(markRetryScheduled).toHaveBeenCalledTimes(3)
    jest.advanceTimersByTime(60 * 60_000)
    await flushAsync()
    expect(runIndex).toHaveBeenCalledTimes(4)
    service.onVaultPathChanged('after-exhaustion.md')
    jest.advanceTimersByTime(5 * 60_000)
    await flushAsync()
    expect(runIndex).toHaveBeenCalledTimes(4)

    cleanup()
  })

  it('resets the backoff counter after a successful run', async () => {
    const transientError = new Error('network timeout')
    const { service, runIndex, markRetryScheduled, setRetryCount, cleanup } =
      createService()
    runIndex
      .mockRejectedValueOnce(transientError) // run 1: fail (delay 5m)
      .mockRejectedValueOnce(transientError) // run 2: fail (delay 15m)
      .mockImplementationOnce(async () => setRetryCount(0)) // run 3: success
      .mockRejectedValueOnce(transientError) // run 5: fail again → delay 5m

    service.onVaultPathChanged('foo.md')
    jest.advanceTimersByTime(5 * 60_000)
    await flushAsync()
    jest.advanceTimersByTime(5 * 60_000) // retry 1 fails → 15m
    await flushAsync()
    jest.advanceTimersByTime(15 * 60_000) // retry 2 succeeds, counter reset
    await flushAsync()

    // Cooldown is 2m after the successful run; a new edit + idle triggers run.
    service.onVaultPathChanged('bar.md')
    jest.advanceTimersByTime(5 * 60_000)
    await flushAsync()

    const lastCall = markRetryScheduled.mock.calls.at(-1)?.[1] as {
      retryAt: number
    }
    // Fresh failure after a success must restart at the base 5m delay.
    expect(lastCall.retryAt - Date.now()).toBe(5 * 60_000)
    cleanup()
  })

  it('does not reset the retry budget after an aborted run', async () => {
    const transientError = new Error('network timeout')
    const abortError = Object.assign(new Error('Indexing cancelled by user'), {
      name: 'AbortError',
    })
    const { service, runIndex, markRetryScheduled, cleanup } = createService()
    runIndex
      .mockRejectedValueOnce(transientError) // run 1: fail → backoff counter = 1 (delay 5m)
      .mockRejectedValueOnce(abortError) // retry 1: aborted without reset
      .mockRejectedValueOnce(transientError) // run after a new edit → fresh failure

    service.onVaultPathChanged('foo.md')
    jest.advanceTimersByTime(5 * 60_000)
    await flushAsync()
    // retry 1 (aborted) reschedules dirty work at the edit-idle window (5m).
    jest.advanceTimersByTime(5 * 60_000)
    await flushAsync()

    // A new edit + idle triggers a fresh run that fails transiently again.
    service.onVaultPathChanged('bar.md')
    jest.advanceTimersByTime(5 * 60_000)
    await flushAsync()

    const lastCall = markRetryScheduled.mock.calls.at(-1)?.[1] as {
      retryAt: number
    }
    expect(lastCall.retryAt - Date.now()).toBe(15 * 60_000)
    cleanup()
  })

  it('does not reset the retry budget after an unknown terminal run', async () => {
    const transientError = new Error('network timeout')
    const unknownError = new Error('totally unexpected failure')
    const { service, runIndex, markRetryScheduled, cleanup } = createService()
    runIndex
      .mockRejectedValueOnce(transientError) // run 1: fail → backoff counter = 1 (delay 5m)
      .mockRejectedValueOnce(unknownError) // retry 1: unknown terminal, no retry
      .mockRejectedValueOnce(transientError) // run after a new edit → fresh failure

    service.onVaultPathChanged('foo.md')
    jest.advanceTimersByTime(5 * 60_000)
    await flushAsync()
    expect(runIndex).toHaveBeenCalledTimes(1)

    // retry 1 fires and ends in an unknown terminal state (no retry scheduled).
    jest.advanceTimersByTime(5 * 60_000)
    await flushAsync()
    expect(runIndex).toHaveBeenCalledTimes(2)

    // A new edit + idle triggers a fresh run that fails transiently again.
    service.onVaultPathChanged('bar.md')
    jest.advanceTimersByTime(5 * 60_000)
    await flushAsync()

    const lastCall = markRetryScheduled.mock.calls.at(-1)?.[1] as {
      retryAt: number
    }
    expect(lastCall.retryAt - Date.now()).toBe(15 * 60_000)
    cleanup()
  })

  it('lets onOnline fast-forward a retry restored via restoreRetryScheduled', async () => {
    // restoreRetryScheduled sets hasPendingTransientRetry, so a connectivity
    // restore should bring the restored retry forward instead of waiting out
    // the full persisted delay.
    const { service, runIndex, cleanup } = createService()

    service.restoreRetryScheduled('kb-a', Date.now() + 30 * 60_000)
    // Nothing has fired yet (retry is 30m out).
    jest.advanceTimersByTime(60_000)
    await flushAsync()
    expect(runIndex).not.toHaveBeenCalled()

    // Connectivity restored: the pending transient retry is fast-forwarded.
    service.onOnline()
    jest.advanceTimersByTime(0)
    await flushAsync()
    expect(runIndex).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('keeps the retry scope vault-wide when an all-scope run fails transiently', async () => {
    const transientError = new Error('network timeout')
    const { service, runIndex, cleanup } = createService()
    runIndex
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce(undefined)

    // A folder rename/delete forces a vault-wide ('all') reconcile, while a
    // file edit adds a pending path. The failed 'all' run must retry as 'all',
    // not degrade to the paths-only pending snapshot.
    service.onVaultPathChanged('renamed-folder', { requiresFullScan: true })
    service.onVaultPathChanged('foo.md')
    jest.advanceTimersByTime(5 * 60_000)
    await flushAsync()

    expect(runIndex).toHaveBeenNthCalledWith(1, 'kb-a', { kind: 'all' })

    jest.advanceTimersByTime(5 * 60_000)
    await flushAsync()

    expect(runIndex).toHaveBeenNthCalledWith(2, 'kb-a', { kind: 'all' })
    cleanup()
  })

  it('keeps a recovered-retry all-scope run vault-wide after it fails transiently', async () => {
    // A retry restored from disk runs vault-wide (recoveredRetrySnapshot →
    // kind: 'all'). If it fails transiently, the next retry must STAY 'all'
    // (carry hasRecoveredRetry forward), not degrade to a paths-only run from
    // the empty pending snapshot.
    const transientError = new Error('network timeout')
    const { service, runIndex, cleanup } = createService()
    runIndex
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce(undefined)

    service.restoreRetryScheduled('kb-a', Date.now() + 5 * 60_000)
    jest.advanceTimersByTime(5 * 60_000)
    await flushAsync()

    expect(runIndex).toHaveBeenNthCalledWith(1, 'kb-a', { kind: 'all' })

    jest.advanceTimersByTime(5 * 60_000)
    await flushAsync()

    expect(runIndex).toHaveBeenNthCalledWith(2, 'kb-a', { kind: 'all' })
    cleanup()
  })

  it('onOnline only fast-forwards a pending transient retry', async () => {
    const { service, runIndex, cleanup } = createService()

    // No pending transient retry: onOnline during an ordinary debounce must be
    // a no-op (the 5m idle timer should still be the only thing that fires).
    service.onVaultPathChanged('foo.md')
    service.onOnline()
    jest.advanceTimersByTime(0)
    await flushAsync()
    expect(runIndex).not.toHaveBeenCalled()

    jest.advanceTimersByTime(5 * 60_000)
    await flushAsync()
    expect(runIndex).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('onOnline advances a retry waiting out its backoff (past the cooldown)', async () => {
    const transientError = new Error('network timeout')
    const { service, runIndex, cleanup } = createService()
    runIndex
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce(undefined)

    service.onVaultPathChanged('foo.md')
    jest.advanceTimersByTime(5 * 60_000)
    await flushAsync()
    expect(runIndex).toHaveBeenCalledTimes(1)

    // Retry is now scheduled 5m out. Move past the 2m success-cooldown window,
    // then signal connectivity restored: the retry should be brought forward.
    jest.advanceTimersByTime(2 * 60_000 + 1_000)
    service.onOnline()
    jest.advanceTimersByTime(0)
    await flushAsync()

    expect(runIndex).toHaveBeenCalledTimes(2)
    cleanup()
  })
})
