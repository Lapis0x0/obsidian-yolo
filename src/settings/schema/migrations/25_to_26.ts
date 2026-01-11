export const migrateFrom25To26 = (
  data: Record<string, unknown>,
): Record<string, unknown> => {
  const {
    languagePreference: _languagePreference,
    language: _legacyLanguage,
    ...rest
  } = data
  return rest
}
