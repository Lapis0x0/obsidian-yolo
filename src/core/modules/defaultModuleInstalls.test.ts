import {
  DEFAULT_INSTALLED_MODULE_IDS,
  seedDefaultModuleInstallIntents,
} from './defaultModuleInstalls'

describe('DEFAULT_INSTALLED_MODULE_IDS', () => {
  it('declares Whiteboard core and leaves Learning optional', () => {
    expect(DEFAULT_INSTALLED_MODULE_IDS).toContain('whiteboard')
    expect(DEFAULT_INSTALLED_MODULE_IDS).not.toContain('learning')
  })
})

describe('seedDefaultModuleInstallIntents', () => {
  it('seeds enabled intent for a module the user never decided on', async () => {
    const enableIfAbsent = jest.fn().mockResolvedValue('created')

    const seeded = await seedDefaultModuleInstallIntents({
      moduleIds: ['whiteboard'],
      enableIfAbsent,
    })

    expect(enableIfAbsent).toHaveBeenCalledWith('whiteboard')
    expect(seeded).toEqual(['whiteboard'])
  })

  it('leaves an existing decision untouched', async () => {
    const enableIfAbsent = jest.fn().mockResolvedValue('already-present')

    const seeded = await seedDefaultModuleInstallIntents({
      moduleIds: ['whiteboard'],
      enableIfAbsent,
    })

    expect(seeded).toEqual([])
  })

  it('reports a failure and still seeds the remaining modules', async () => {
    const failure = new Error('intent write failed')
    const enableIfAbsent = jest
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce('created')
    const reportError = jest.fn()

    const seeded = await seedDefaultModuleInstallIntents({
      moduleIds: ['broken', 'whiteboard'],
      enableIfAbsent,
      reportError,
    })

    expect(reportError).toHaveBeenCalledWith('broken', failure)
    expect(seeded).toEqual(['whiteboard'])
  })

  it('defaults to the host declaration', async () => {
    const enableIfAbsent = jest.fn().mockResolvedValue('already-present')

    await seedDefaultModuleInstallIntents({ enableIfAbsent })

    expect(enableIfAbsent.mock.calls.map(([id]) => id as string)).toEqual([
      ...DEFAULT_INSTALLED_MODULE_IDS,
    ])
  })
})
