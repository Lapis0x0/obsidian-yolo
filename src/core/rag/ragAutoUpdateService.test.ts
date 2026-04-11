jest.mock('obsidian', () => ({
  Notice: class {},
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

    const service = new RagAutoUpdateService({
      getSettings: () => settings,
      setSettings,
      getRagEngine,
      t: (key) => key,
    })

    return {
      service,
      settings,
      updateVaultIndex,
      getRagEngine,
      setSettings,
    }
  }

  it('waits for one minute of idle time before running auto update', async () => {
    const { service, updateVaultIndex } = createService()

    service.onVaultPathChanged('foo.md')
    jest.advanceTimersByTime(59_000)
    await Promise.resolve()

    expect(updateVaultIndex).not.toHaveBeenCalled()

    jest.advanceTimersByTime(1_000)
    await Promise.resolve()
    await Promise.resolve()

    expect(updateVaultIndex).toHaveBeenCalledTimes(1)
  })

  it('coalesces repeated edits into a single auto update run', async () => {
    const { service, updateVaultIndex } = createService()

    service.onVaultPathChanged('foo.md')
    jest.advanceTimersByTime(30_000)
    service.onVaultPathChanged('foo.md')
    jest.advanceTimersByTime(59_000)
    await Promise.resolve()

    expect(updateVaultIndex).not.toHaveBeenCalled()

    jest.advanceTimersByTime(1_000)
    await Promise.resolve()
    await Promise.resolve()

    expect(updateVaultIndex).toHaveBeenCalledTimes(1)
  })

  it('does not run when knowledge base indexing is disabled', async () => {
    const { service, settings, updateVaultIndex } = createService()

    settings.ragOptions.enabled = false
    service.onVaultPathChanged('foo.md')
    jest.advanceTimersByTime(60_000)
    await Promise.resolve()

    expect(updateVaultIndex).not.toHaveBeenCalled()
  })
})
