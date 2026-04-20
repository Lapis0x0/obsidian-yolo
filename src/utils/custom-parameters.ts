import {
  CustomParameter,
  CustomParameterType,
} from '../types/custom-parameter.types'

export const DEFAULT_CUSTOM_PARAMETER_TYPE: CustomParameterType = 'text'

const LEGACY_NUMERIC_PARAMETER_KEYS = new Set([
  'temperature',
  'top_p',
  'max_tokens',
  'max_output_tokens',
])

function shouldUseLegacyNumericType(
  key: string | undefined,
  type?: string,
): boolean {
  const normalizedType = typeof type === 'string' ? type.trim() : undefined
  if (
    normalizedType === 'text' ||
    normalizedType === 'number' ||
    normalizedType === 'boolean' ||
    normalizedType === 'json'
  ) {
    return false
  }

  const normalizedKey = typeof key === 'string' ? key.trim().toLowerCase() : ''
  return LEGACY_NUMERIC_PARAMETER_KEYS.has(normalizedKey)
}

export function normalizeCustomParameterType(
  value: string | undefined,
): CustomParameterType {
  if (
    value === 'text' ||
    value === 'number' ||
    value === 'boolean' ||
    value === 'json'
  ) {
    return value
  }
  return DEFAULT_CUSTOM_PARAMETER_TYPE
}

export function sanitizeCustomParameters(
  entries: Array<Pick<CustomParameter, 'key' | 'value'> & { type?: string }>,
): CustomParameter[] {
  return entries
    .map((entry) => ({
      key: entry.key.trim(),
      value: entry.value,
      type: normalizeCustomParameterType(entry.type),
    }))
    .filter((entry) => entry.key.length > 0)
}

export function parseCustomParameterValue(
  raw: string,
  type?: string,
  key?: string,
): unknown {
  const normalizedType = shouldUseLegacyNumericType(key, type)
    ? 'number'
    : normalizeCustomParameterType(
        typeof type === 'string' ? type.trim() : type,
      )
  const trimmed = raw.trim()

  if (normalizedType === 'text') {
    return trimmed
  }

  if (trimmed.length === 0) {
    return raw
  }

  if (normalizedType === 'number') {
    const normalizedNumeric =
      trimmed.includes(',') && !trimmed.includes('.')
        ? trimmed.split(',').join('.')
        : trimmed
    const parsed = Number(normalizedNumeric)
    return Number.isFinite(parsed) ? parsed : raw
  }

  if (normalizedType === 'boolean') {
    const lower = trimmed.toLowerCase()
    if (lower === 'true') return true
    if (lower === 'false') return false
    return raw
  }

  try {
    return JSON.parse(trimmed)
  } catch {
    return raw
  }
}
