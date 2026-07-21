import { en } from './en'
import { it } from './it'
import { zh } from './zh'

export type LearningLocale = 'en' | 'zh' | 'it'
export type LearningTranslation = (key: string, fallback?: string) => string
export type LearningLocalizedTextKey =
  | 'module.name'
  | 'module.open'
  | 'settings.generationTitle'
  | 'settings.generationModel'
  | 'settings.generationModelDescription'

export const LEARNING_LOCALES = ['en', 'zh', 'it'] as const
const resources = { en, zh, it } as const

export function normalizeLearningLocale(locale: string): LearningLocale {
  const normalized = locale.trim().toLowerCase()
  if (normalized.startsWith('zh')) return 'zh'
  if (normalized.startsWith('it')) return 'it'
  return 'en'
}

export function createLearningTranslation(locale: string): LearningTranslation {
  const language = normalizeLearningLocale(locale)
  return (key, fallback) => {
    const path = key.startsWith('learning.')
      ? key.slice('learning.'.length).split('.')
      : key.split('.')
    return (
      getNestedString(resources[language], path) ??
      getNestedString(resources.en, path) ??
      fallback ??
      key
    )
  }
}

export function getLearningText(
  locale: LearningLocale,
  key: LearningLocalizedTextKey,
): string {
  const value = getNestedString(resources[locale], key.split('.'))
  if (!value)
    throw new Error(`Missing Learning translation "${key}" for ${locale}`)
  return value
}

export function createLearningLocalizedText(
  key: LearningLocalizedTextKey,
): Readonly<Record<LearningLocale, string>> {
  return Object.freeze(
    Object.fromEntries(
      LEARNING_LOCALES.map((locale) => [locale, getLearningText(locale, key)]),
    ),
  ) as Readonly<Record<LearningLocale, string>>
}

function getNestedString(
  source: unknown,
  path: readonly string[],
): string | undefined {
  let current = source
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return typeof current === 'string' ? current : undefined
}

export { en, it, zh }
