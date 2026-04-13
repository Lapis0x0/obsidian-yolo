jest.mock('obsidian', () => ({
  TAbstractFile: class {},
  TFile: class {},
  TFolder: class {},
}))

import type { SmartComposerSettings } from '../../settings/schema/setting.types'

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
      ragOptions: {
        enabled: true,
        autoUpdateEnabled: true,
        includePatterns: [],
        excludePatterns: [],
        lastAutoUpdateAt: 0,
      },
    } as unknown as SmartComposerSettings
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
    runIndex.mockRejectedValueOnce(transientError).mockResolvedValueOnce(undefined)

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
})
