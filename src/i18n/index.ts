import { en } from './locales/en'
import { it } from './locales/it'
import { zh } from './locales/zh'
import { Language, TranslationKeys } from './types'

const translations: Record<Language, TranslationKeys> = {
  en,
  zh,
  it,
}

export function getTranslation(language: Language): TranslationKeys {
  return translations[language] || translations.en
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getNestedString(
  source: TranslationKeys,
  path: string[],
): string | undefined {
  let current: unknown = source
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined
    }
    current = current[key]
  }
  return typeof current === 'string' ? current : undefined
}

export function createTranslationFunction(language: Language) {
  const t = getTranslation(language)

  return function translate(keyPath: string, fallback?: string): string {
    const keys = keyPath.split('.')
    const value = getNestedString(t, keys)

    return typeof value === 'string' ? value : fallback || keyPath
  }
}

export type { Language, TranslationKeys } from './types'
export { en } from './locales/en'
export { zh } from './locales/zh'
export { it } from './locales/it'
