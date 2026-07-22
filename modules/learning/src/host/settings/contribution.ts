import { LEARNING_LOCALES, getLearningText } from '../../i18n'

const localizations = Object.freeze(
  Object.fromEntries(
    LEARNING_LOCALES.map((locale) => [
      locale,
      Object.freeze({
        title: getLearningText(locale, 'settings.generationTitle'),
        fields: Object.freeze({
          modelId: Object.freeze({
            name: getLearningText(locale, 'settings.generationModel'),
            description: getLearningText(
              locale,
              'settings.generationModelDescription',
            ),
          }),
        }),
      }),
    ]),
  ),
)

export const LEARNING_SETTINGS_CONTRIBUTION = Object.freeze({
  id: 'learning',
  icon: 'graduation-cap',
  title: getLearningText('en', 'settings.generationTitle'),
  fields: Object.freeze([
    Object.freeze({
      key: 'modelId',
      type: 'model' as const,
      name: getLearningText('en', 'settings.generationModel'),
      description: getLearningText('en', 'settings.generationModelDescription'),
    }),
  ]),
  localizations,
}) satisfies YoloModuleHostSettingsContributionV1

export function contributeLearningSettings(
  settings: YoloModuleHostApiV1['settings'],
): void {
  settings.contribute(LEARNING_SETTINGS_CONTRIBUTION)
}
