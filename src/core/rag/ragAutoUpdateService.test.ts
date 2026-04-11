jest.mock('obsidian', () => ({
  TAbstractFile: class {},
  TFile: class {},
  TFolder: class {},
}))

import { BackgroundActivityRegistry } from '../background/backgroundActivityRegistry'
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
        includePatterns: [],
        excludePatterns: [],
        lastAutoUpdateAt: 0,
      },
    } as unknown as SmartComposerSettings
    const updateVaultIndex = jest.fn().mockResolvedValue(undefined)
    const getRagEngine = jest.fn().mockResolvedValue({ updateVaultIndex })
    const setSettings = jest.fn().mockResolvedValue(undefined)
    const activityRegistry = new BackgroundActivityRegistry()
    let latestActivities = new Map()
    const unsubscribe = activityRegistry.subscribe((activities) => {
      latestActivities = activities
    })

    const service = new RagAutoUpdateService({
      getSettings: () => settings,
      setSettings,
      getRagEngine,
      t: (key) => key,
      activityRegistry,
    })

    return {
      service,
      settings,
      updateVaultIndex,
      getRagEngine,
      setSettings,
      latestActivities: () => latestActivities,
      cleanup: () => unsubscribe(),
    }
  }

  it('waits for five minutes of idle time before running auto update', async () => {
    const { service, updateVaultIndex, cleanup } = createService()

    service.onVaultPathChanged('foo.md')
    jest.advanceTimersByTime(299_000)
    await flushAsync()

    expect(updateVaultIndex).not.toHaveBeenCalled()

    jest.advanceTimersByTime(1_000)
    await flushAsync()

    expect(updateVaultIndex).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('coalesces repeated edits into a single auto update run', async () => {
    const { service, updateVaultIndex, cleanup } = createService()

    service.onVaultPathChanged('foo.md')
    jest.advanceTimersByTime(30_000)
    service.onVaultPathChanged('foo.md')
    jest.advanceTimersByTime(299_000)
    await flushAsync()

    expect(updateVaultIndex).not.toHaveBeenCalled()

    jest.advanceTimersByTime(1_000)
    await flushAsync()

    expect(updateVaultIndex).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('does not run when knowledge base indexing is disabled', async () => {
    const { service, settings, updateVaultIndex, cleanup } = createService()

    settings.ragOptions.enabled = false
    service.onVaultPathChanged('foo.md')
    jest.advanceTimersByTime(5 * 60_000)
    await flushAsync()

    expect(updateVaultIndex).not.toHaveBeenCalled()
    cleanup()
  })

  it('does not schedule updates for non-markdown paths', async () => {
    const { service, updateVaultIndex, latestActivities, cleanup } =
      createService()

    service.onVaultPathChanged('foo.png')
    jest.advanceTimersByTime(5 * 60_000)
    await flushAsync()

    expect(updateVaultIndex).not.toHaveBeenCalled()
    expect(latestActivities().size).toBe(0)
    cleanup()
  })

  it('runs sooner when the window blurs after a short grace period', async () => {
    const { service, updateVaultIndex, cleanup } = createService()

    service.onVaultPathChanged('foo.md')
    jest.advanceTimersByTime(15_000)
    service.onWindowBlur()
    jest.advanceTimersByTime(0)
    await flushAsync()

    expect(updateVaultIndex).toHaveBeenCalledTimes(1)
    cleanup()
  })
})
