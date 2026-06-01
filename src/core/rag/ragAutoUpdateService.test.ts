jest.mock('obsidian', () => ({
  TAbstractFile: class {},
  TFile: class {},
  TFolder: class {},
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
        includePatterns: [],
        excludePatterns: [],
        lastAutoUpdateAt: 0,
        indexPdf: true,
      },
    } as unknown as YoloSettings
    const runIndex = jest.fn().mockResolvedValue(undefined)
    const setSettings = jest.fn().mockResolvedValue(undefined)
    const markRetryScheduled = jest.fn().mockResolvedValue(undefined)
    const clearRetryScheduled = jest.fn().mockResolvedValue(undefined)

    const service = new RagAutoUpdateService({
      getSettings: () => settings,
      setSettings,
      runIndex,
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

    service.restoreRetryScheduled(Date.now() + 5 * 60_000)
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

  it('grows the retry delay exponentially and caps at 30 minutes', async () => {
    const transientError = new Error('network timeout')
    const { service, runIndex, markRetryScheduled, cleanup } = createService()
    // Always fail transiently.
    runIndex.mockRejectedValue(transientError)

    service.onVaultPathChanged('foo.md')

    const expectedDelaysMs = [
      5 * 60_000, // 5m
      10 * 60_000, // 10m
      20 * 60_000, // 20m
      30 * 60_000, // capped at 30m
      30 * 60_000, // still capped
    ]

    // Advance by the EDIT_IDLE_WINDOW first to trigger the initial run.
    jest.advanceTimersByTime(5 * 60_000)
    await flushAsync()

    for (let i = 0; i < expectedDelaysMs.length; i += 1) {
      const before = Date.now()
      const lastCall = markRetryScheduled.mock.calls.at(-1)?.[0] as {
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

    cleanup()
  })

  it('resets the backoff counter after a successful run', async () => {
    const transientError = new Error('network timeout')
    const { service, runIndex, markRetryScheduled, cleanup } = createService()
    runIndex
      .mockRejectedValueOnce(transientError) // run 1: fail (delay 5m)
      .mockRejectedValueOnce(transientError) // run 2: fail (delay 10m)
      .mockResolvedValueOnce(undefined) // run 3: success (reset)
      .mockRejectedValueOnce(transientError) // run 5: fail again → delay 5m

    service.onVaultPathChanged('foo.md')
    jest.advanceTimersByTime(5 * 60_000)
    await flushAsync()
    jest.advanceTimersByTime(5 * 60_000) // retry 1 fails → 10m
    await flushAsync()
    jest.advanceTimersByTime(10 * 60_000) // retry 2 succeeds, counter reset
    await flushAsync()

    // Cooldown is 2m after the successful run; a new edit + idle triggers run.
    service.onVaultPathChanged('bar.md')
    jest.advanceTimersByTime(5 * 60_000)
    await flushAsync()

    const lastCall = markRetryScheduled.mock.calls.at(-1)?.[0] as {
      retryAt: number
    }
    // Fresh failure after a success must restart at the base 5m delay.
    expect(lastCall.retryAt - Date.now()).toBe(5 * 60_000)
    cleanup()
  })

  it('resets the backoff counter after an aborted terminal run', async () => {
    const transientError = new Error('network timeout')
    const abortError = Object.assign(new Error('Indexing cancelled by user'), {
      name: 'AbortError',
    })
    const { service, runIndex, markRetryScheduled, cleanup } = createService()
    runIndex
      .mockRejectedValueOnce(transientError) // run 1: fail → backoff counter = 1 (delay 5m)
      .mockRejectedValueOnce(abortError) // retry 1: aborted terminal → counter reset
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

    const lastCall = markRetryScheduled.mock.calls.at(-1)?.[0] as {
      retryAt: number
    }
    // If the aborted run had not reset the counter, the delay would be 10m.
    expect(lastCall.retryAt - Date.now()).toBe(5 * 60_000)
    cleanup()
  })

  it('resets the backoff counter after an unknown terminal run', async () => {
    const transientError = new Error('network timeout')
    const unknownError = new Error('totally unexpected failure')
    const { service, runIndex, markRetryScheduled, cleanup } = createService()
    runIndex
      .mockRejectedValueOnce(transientError) // run 1: fail → backoff counter = 1 (delay 5m)
      .mockRejectedValueOnce(unknownError) // retry 1: unknown terminal → counter reset, no retry
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

    const lastCall = markRetryScheduled.mock.calls.at(-1)?.[0] as {
      retryAt: number
    }
    // Unknown reset the counter, so the fresh transient failure restarts at 5m.
    expect(lastCall.retryAt - Date.now()).toBe(5 * 60_000)
    cleanup()
  })

  it('lets onOnline fast-forward a retry restored via restoreRetryScheduled', async () => {
    // restoreRetryScheduled sets hasPendingTransientRetry, so a connectivity
    // restore should bring the restored retry forward instead of waiting out
    // the full persisted delay.
    const { service, runIndex, cleanup } = createService()

    service.restoreRetryScheduled(Date.now() + 30 * 60_000)
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

    expect(runIndex).toHaveBeenNthCalledWith(1, { kind: 'all' })

    jest.advanceTimersByTime(5 * 60_000)
    await flushAsync()

    expect(runIndex).toHaveBeenNthCalledWith(2, { kind: 'all' })
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

    service.restoreRetryScheduled(Date.now() + 5 * 60_000)
    jest.advanceTimersByTime(5 * 60_000)
    await flushAsync()

    expect(runIndex).toHaveBeenNthCalledWith(1, { kind: 'all' })

    jest.advanceTimersByTime(5 * 60_000)
    await flushAsync()

    expect(runIndex).toHaveBeenNthCalledWith(2, { kind: 'all' })
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
