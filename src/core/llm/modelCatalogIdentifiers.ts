const MODEL_IDENTIFIER_KEYS = ['id', 'slug', 'name', 'model'] as const

export const extractModelIdentifier = (value: unknown): string | null => {
  if (typeof value === 'string') {
    return value
  }
  if (!value || typeof value !== 'object') {
    return null
  }
  const record = value as Record<string, unknown>
  for (const key of MODEL_IDENTIFIER_KEYS) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate
    }
  }
  return null
}

const isHiddenModel = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false
  return (value as Record<string, unknown>).visibility === 'hide'
}

export const collectModelIdentifiers = (values: unknown[]): string[] =>
  values
    .filter((entry) => !isHiddenModel(entry))
    .map((entry) => extractModelIdentifier(entry))
    .filter((id): id is string => Boolean(id))
