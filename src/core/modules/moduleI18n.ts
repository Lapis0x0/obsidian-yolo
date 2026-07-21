import { type LocaleStore, localeStore } from '../i18n/localeStore'

import type { ModuleLifecycleScope } from './lifecycleScope'
import type { YoloModuleI18nV1 } from './types'

export type LocalizedTextV1 = string | Readonly<Record<string, string>>

export function resolveLocalizedText(
  value: LocalizedTextV1,
  locale: string,
): string {
  if (typeof value === 'string') return value
  const normalized = locale.toLowerCase()
  return (
    value[normalized] ??
    value[normalized.split('-')[0] ?? ''] ??
    value.en ??
    Object.values(value)[0] ??
    ''
  )
}

export function snapshotLocalizedText(
  value: LocalizedTextV1,
  label: string,
): LocalizedTextV1 {
  if (typeof value === 'string') {
    requireText(value, label)
    return value
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a string or locale map`)
  }
  const entries = Object.entries(value)
  if (entries.length === 0) throw new Error(`${label} locale map is empty`)
  const result: Record<string, string> = {}
  for (const [locale, text] of entries) {
    requireText(locale, `${label} locale`)
    requireText(text, `${label} text`)
    result[locale.toLowerCase()] = text
  }
  if (!result.en) throw new Error(`${label} must include an English fallback`)
  return Object.freeze(result)
}

export type ModuleI18nCapabilityProviderV1 = Readonly<{
  create(
    moduleId: string,
    lifecycle: ModuleLifecycleScope,
  ): Readonly<{ api: YoloModuleI18nV1 }>
}>

export class ModuleI18nCapabilityProvider
  implements ModuleI18nCapabilityProviderV1
{
  constructor(private readonly store: LocaleStore = localeStore) {}

  create(_moduleId: string, lifecycle: ModuleLifecycleScope) {
    const subscriptions = new Set<() => void>()
    lifecycle.add(() => {
      for (const unsubscribe of subscriptions) unsubscribe()
      subscriptions.clear()
    })
    return Object.freeze({
      api: Object.freeze({
        getSnapshot: this.store.getSnapshot,
        subscribe: (listener: () => void) => {
          const unsubscribeStore = this.store.subscribe(listener)
          let subscribed = true
          const unsubscribe = () => {
            if (!subscribed) return
            subscribed = false
            subscriptions.delete(unsubscribe)
            unsubscribeStore()
          }
          subscriptions.add(unsubscribe)
          return unsubscribe
        },
      }),
    })
  }
}

function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`)
  }
}
