import { Language } from '../../../i18n'

const SUPPORTED_LANGUAGES = new Set<Language>(['en', 'zh', 'it'])

export const migrateFrom21To22 = (
  data: Record<string, unknown>,
): Record<string, unknown> => {
  const rawLanguage = data.language
  const languagePreference =
    typeof rawLanguage === 'string' &&
    SUPPORTED_LANGUAGES.has(rawLanguage as Language)
      ? rawLanguage
      : 'auto'

  const { language: _legacyLanguage, ...rest } = data

  return {
    ...rest,
    languagePreference,
  }
}
