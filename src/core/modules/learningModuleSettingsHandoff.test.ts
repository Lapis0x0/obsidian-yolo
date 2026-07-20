import { handoffLearningLegacySettings } from './learningModuleSettingsHandoff'

describe('handoffLearningLegacySettings', () => {
  it('passes the raw legacy values in a schema-zero learning envelope', async () => {
    const createIfAbsent = jest.fn().mockResolvedValue('created')
    const legacy = {
      modelId: 42,
      betaNoticeAcknowledged: 'raw-value',
    }

    await expect(
      handoffLearningLegacySettings(createIfAbsent, legacy),
    ).resolves.toBe('created')
    expect(createIfAbsent).toHaveBeenCalledWith('learning', {
      schemaVersion: 0,
      data: {
        modelId: 42,
        betaNoticeAcknowledged: 'raw-value',
      },
    })
  })

  it('reports an existing module config without requesting a replacement', async () => {
    const createIfAbsent = jest.fn().mockResolvedValue('already-present')

    await expect(
      handoffLearningLegacySettings(createIfAbsent, {
        modelId: 'legacy-model',
        betaNoticeAcknowledged: true,
      }),
    ).resolves.toBe('already-present')
    expect(createIfAbsent).toHaveBeenCalledTimes(1)
  })

  it('omits absent legacy values so a fresh install produces valid JSON', async () => {
    const createIfAbsent = jest.fn().mockResolvedValue('created')

    await expect(
      handoffLearningLegacySettings(createIfAbsent, undefined),
    ).resolves.toBe('created')
    expect(createIfAbsent).toHaveBeenCalledWith('learning', {
      schemaVersion: 0,
      data: {},
    })
  })

  it('preserves the legacy values that are present without adding absent ones', async () => {
    const createIfAbsent = jest.fn().mockResolvedValue('created')

    await handoffLearningLegacySettings(createIfAbsent, {
      betaNoticeAcknowledged: false,
    })
    expect(createIfAbsent).toHaveBeenCalledWith('learning', {
      schemaVersion: 0,
      data: { betaNoticeAcknowledged: false },
    })
  })
})
