import type { Language, TranslationKeys } from './types'

const translations: Partial<Record<Language, TranslationKeys>> = {}

export async function loadLocale(language: Language): Promise<void> {
  if (translations[language]) {
    return
  }

  if (language === 'zh') {
    translations.zh = (await import('./locales/zh')).zh
    return
  }
  if (language === 'it') {
    translations.it = (await import('./locales/it')).it
    return
  }
  translations.en = (await import('./locales/en')).en
}

export function getTranslation(language: Language): TranslationKeys | null {
  return translations[language] ?? translations.en ?? null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getNestedString(
  source: TranslationKeys | null,
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
