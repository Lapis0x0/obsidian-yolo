export const migrateFrom25To26 = (
  data: Record<string, unknown>,
): Record<string, unknown> => {
  const rest = { ...data }
  delete rest['languagePreference']
  delete rest['language']
  return rest
}
