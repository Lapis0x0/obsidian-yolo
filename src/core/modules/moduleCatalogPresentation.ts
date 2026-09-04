export const MODULE_CATALOG_LOCALES = ['en', 'zh', 'it'] as const

export type ModuleCatalogLocale = (typeof MODULE_CATALOG_LOCALES)[number]
export type ModuleCatalogLocaleSource =
  | ModuleCatalogLocale
  | (() => ModuleCatalogLocale)

export type ModuleCatalogPresentation = Readonly<{
  name: string
  description: string
}>

/**
 * `en` is required because it is the fallback every other locale resolves to;
 * the rest are optional so a publisher can add a locale this build has never
 * heard of without breaking it.
 */
export type ModuleCatalogLocalizations = Readonly<
  Partial<Record<ModuleCatalogLocale, ModuleCatalogPresentation>> & {
    en: ModuleCatalogPresentation
  }
>

export function parseModuleCatalogLocalizations(
  value: unknown,
  label: string,
): ModuleCatalogLocalizations {
  const source = asPlainObject(value, label)
  const parsed: Partial<
    Record<ModuleCatalogLocale, ModuleCatalogPresentation>
  > = {}
  for (const locale of MODULE_CATALOG_LOCALES) {
    // A locale this build does not know is simply not rendered; requiring an
    // exact set would make adding one a breaking change for older clients.
    if (!Object.prototype.hasOwnProperty.call(source, locale)) continue
    const localized = asPlainObject(source[locale], `${label} ${locale}`)
    if (
      typeof localized.name !== 'string' ||
      !localized.name.trim() ||
      typeof localized.description !== 'string' ||
      !localized.description.trim()
    ) {
      throw new Error(`${label} ${locale} is invalid`)
    }
    parsed[locale] = Object.freeze({
      name: localized.name,
      description: localized.description,
    })
  }
  if (!parsed.en) {
    throw new Error(`${label} must provide the en fallback`)
  }
  return Object.freeze(parsed) as ModuleCatalogLocalizations
}

export function resolveModuleCatalogPresentation(
  localizations: ModuleCatalogLocalizations,
  locale: ModuleCatalogLocale,
): ModuleCatalogPresentation {
  return localizations[locale] ?? localizations.en
}

export function readModuleCatalogLocale(
  source: ModuleCatalogLocaleSource,
): ModuleCatalogLocale {
  const locale = typeof source === 'function' ? source() : source
  if (!MODULE_CATALOG_LOCALES.includes(locale)) {
    throw new Error('Module catalog locale is invalid')
  }
  return locale
}

export function normalizeModuleCatalogLocale(
  locale: string,
): ModuleCatalogLocale {
  const normalized = locale.trim().toLowerCase()
  if (normalized.startsWith('zh')) return 'zh'
  if (normalized.startsWith('it')) return 'it'
  return 'en'
}

function asPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`)
  }
  return value as Record<string, unknown>
}
