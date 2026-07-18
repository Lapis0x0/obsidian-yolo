export const LEARNING_SETTINGS_CONTRIBUTION = Object.freeze({
  id: 'learning',
  title: 'Generation',
  fields: Object.freeze([
    Object.freeze({
      key: 'modelId',
      type: 'model' as const,
      name: 'Learning generation model',
      description:
        'Used to generate outlines, knowledge points, and cards. This selection is independent of the current assistant.',
    }),
  ]),
}) satisfies YoloModuleHostSettingsContributionV1

export function contributeLearningSettings(
  settings: YoloModuleHostApiV1['settings'],
): void {
  settings.contribute(LEARNING_SETTINGS_CONTRIBUTION)
}
