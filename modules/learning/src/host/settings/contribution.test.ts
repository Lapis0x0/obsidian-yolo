import {
  LEARNING_SETTINGS_CONTRIBUTION,
  contributeLearningSettings,
} from './contribution'

describe('Learning settings contribution', () => {
  it('declares the module-owned generation model field', () => {
    const contribute = jest.fn()

    contributeLearningSettings({
      contribute,
    } as unknown as YoloModuleHostApiV1['settings'])

    expect(contribute).toHaveBeenCalledWith(LEARNING_SETTINGS_CONTRIBUTION)
    expect(LEARNING_SETTINGS_CONTRIBUTION).toEqual(
      expect.objectContaining({
        id: 'learning',
        icon: 'graduation-cap',
        title: 'Generation',
        fields: [
          {
            key: 'modelId',
            type: 'model',
            name: 'Learning generation model',
            description:
              'Used to generate outlines, knowledge points, and cards. This selection is independent of the current assistant.',
          },
        ],
        localizations: {
          en: expect.any(Object),
          zh: expect.any(Object),
          it: expect.any(Object),
        },
      }),
    )
    expect(LEARNING_SETTINGS_CONTRIBUTION.fields).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'betaNoticeAcknowledged' }),
      ]),
    )
  })
})
