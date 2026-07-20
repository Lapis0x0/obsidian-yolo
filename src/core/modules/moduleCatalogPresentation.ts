export const MODULE_CATALOG_LOCALES = ['en', 'zh', 'it'] as const

export type ModuleCatalogLocale = (typeof MODULE_CATALOG_LOCALES)[number]

export type ModuleCatalogPresentation = Readonly<{
  name: string
  description: string
}>

export type ModuleCatalogLocalizations = Readonly<
  Record<ModuleCatalogLocale, ModuleCatalogPresentation>
>

export function parseModuleCatalogLocalizations(
  value: unknown,
  label: string,
): ModuleCatalogLocalizations {
  const source = asPlainObject(value, label)
  assertExactKeys(source, MODULE_CATALOG_LOCALES, label)
  return Object.freeze(
    Object.fromEntries(
      MODULE_CATALOG_LOCALES.map((locale) => {
        const localized = asPlainObject(source[locale], `${label} ${locale}`)
        assertExactKeys(
          localized,
          ['name', 'description'],
          `${label} ${locale}`,
        )
        if (
          typeof localized.name !== 'string' ||
          !localized.name.trim() ||
          typeof localized.description !== 'string' ||
          !localized.description.trim()
        ) {
          throw new Error(`${label} ${locale} is invalid`)
        }
        return [
          locale,
          Object.freeze({
            name: localized.name,
            description: localized.description,
          }),
        ]
      }),
    ),
  ) as ModuleCatalogLocalizations
}

export function resolveModuleCatalogPresentation(
  localizations: ModuleCatalogLocalizations,
  locale: ModuleCatalogLocale,
): ModuleCatalogPresentation {
  return localizations[locale] ?? localizations.en
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

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value)
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expected.includes(key))
  ) {
    throw new Error(`${label} fields are invalid`)
  }
}
