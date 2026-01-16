export const migrateFrom21To22 = (
  data: Record<string, unknown>,
): Record<string, unknown> => {
  const rest = { ...data }
  delete rest['language']
  delete rest['languagePreference']
  return rest
}
