import { getLanguage } from 'obsidian'

export type LocaleSnapshot = Readonly<{ locale: string }>

type LocaleStoreEnvironment = Readonly<{
  readLocale(): string
  document?: Document
  window?: Window
  createObserver?(
    listener: () => void,
  ): Pick<MutationObserver, 'observe' | 'disconnect'>
}>

export class LocaleStore {
  private readonly listeners = new Set<() => void>()
  private snapshot: LocaleSnapshot
  private observer: Pick<MutationObserver, 'observe' | 'disconnect'> | null =
    null

  constructor(private readonly environment: LocaleStoreEnvironment) {
    this.snapshot = Object.freeze({
      locale: normalizeLocale(environment.readLocale()),
    })
  }

  getSnapshot = (): LocaleSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    if (typeof listener !== 'function') {
      throw new TypeError('Locale listener must be a function')
    }
    const wasEmpty = this.listeners.size === 0
    this.listeners.add(listener)
    if (wasEmpty) this.start()
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.stop()
    }
  }

  refresh = (): void => {
    const locale = normalizeLocale(this.environment.readLocale())
    if (locale === this.snapshot.locale) return
    this.snapshot = Object.freeze({ locale })
    for (const listener of this.listeners) listener()
  }

  private start(): void {
    const root = this.environment.document?.documentElement
    const createObserver =
      this.environment.createObserver ??
      (typeof MutationObserver === 'undefined'
        ? undefined
        : (listener: () => void) => new MutationObserver(listener))
    if (root && createObserver) {
      this.observer = createObserver(this.refresh)
      this.observer.observe(root, {
        attributeFilter: ['lang'],
        attributes: true,
      })
    }
    this.environment.window?.addEventListener('languagechange', this.refresh)
    this.refresh()
  }

  private stop(): void {
    this.observer?.disconnect()
    this.observer = null
    this.environment.window?.removeEventListener('languagechange', this.refresh)
  }
}

export function normalizeLocale(value: unknown): string {
  const normalized = (typeof value === 'string' ? value : '')
    .trim()
    .replace(/_/g, '-')
    .toLowerCase()
  return normalized || 'en'
}

export const localeStore = new LocaleStore({
  readLocale: () =>
    String(typeof getLanguage === 'function' ? (getLanguage() ?? '') : 'en'),
  document: typeof document === 'undefined' ? undefined : document,
  window: typeof window === 'undefined' ? undefined : window,
})
