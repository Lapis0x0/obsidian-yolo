// i18n for the Whiteboard module, following the Learning module's pattern
// (modules/learning/src/i18n/index.ts). The locale set matches
// module.config.json's `localizations` — a locale declared there and missing
// here would show its module name translated and everything inside it in
// English.

import { en } from './en'
import { it } from './it'
import { zh } from './zh'

export type WhiteboardLocale = 'en' | 'zh' | 'it'
export type WhiteboardTranslation = (key: string, fallback?: string) => string
export type WhiteboardLocalizedTextKey =
  | 'module.name'
  | 'module.open'
  | 'command.newWhiteboard'
  | 'command.importAllCanvas'
  | 'menu.newWhiteboard'
  | 'menu.importCanvas'
  | 'tools.label'
  | 'tools.description'

export const WHITEBOARD_LOCALES = ['en', 'zh', 'it'] as const
const resources = { en, zh, it } as const

export function normalizeWhiteboardLocale(locale: string): WhiteboardLocale {
  const normalized = locale.trim().toLowerCase()
  if (normalized.startsWith('zh')) return 'zh'
  if (normalized.startsWith('it')) return 'it'
  return 'en'
}

export function createWhiteboardTranslation(
  locale: string,
): WhiteboardTranslation {
  const language = normalizeWhiteboardLocale(locale)
  return (key, fallback) => {
    const path = key.startsWith('whiteboard.')
      ? key.slice('whiteboard.'.length).split('.')
      : key.split('.')
    return (
      getNestedString(resources[language], path) ??
      getNestedString(resources.en, path) ??
      fallback ??
      key
    )
  }
}

export function getWhiteboardText(
  locale: WhiteboardLocale,
  key: WhiteboardLocalizedTextKey,
): string {
  const value = getNestedString(resources[locale], key.split('.'))
  if (!value)
    throw new Error(`Missing Whiteboard translation "${key}" for ${locale}`)
  return value
}

export function createWhiteboardLocalizedText(
  key: WhiteboardLocalizedTextKey,
): Readonly<Record<WhiteboardLocale, string>> {
  return Object.freeze(
    Object.fromEntries(
      WHITEBOARD_LOCALES.map((locale) => [
        locale,
        getWhiteboardText(locale, key),
      ]),
    ),
  ) as Readonly<Record<WhiteboardLocale, string>>
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
