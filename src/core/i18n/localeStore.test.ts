import { LocaleStore, normalizeLocale } from './localeStore'

describe('LocaleStore', () => {
  it('keeps snapshot references stable and notifies only for real locale changes', () => {
    let locale = 'en-US'
    let observerListener: (() => void) | undefined
    const disconnect = jest.fn()
    const addEventListener = jest.fn()
    const removeEventListener = jest.fn()
    const store = new LocaleStore({
      readLocale: () => locale,
      document: { documentElement: {} } as Document,
      window: { addEventListener, removeEventListener } as unknown as Window,
      createObserver: (listener) => {
        observerListener = listener
        return { observe: jest.fn(), disconnect }
      },
    })
    const initial = store.getSnapshot()
    const listener = jest.fn()
    const unsubscribe = store.subscribe(listener)

    observerListener?.()
    expect(store.getSnapshot()).toBe(initial)
    expect(listener).not.toHaveBeenCalled()

    locale = 'zh_CN'
    observerListener?.()
    expect(store.getSnapshot()).toEqual({ locale: 'zh-cn' })
    expect(store.getSnapshot()).not.toBe(initial)
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(removeEventListener).toHaveBeenCalledWith(
      'languagechange',
      store.refresh,
    )
  })

  it('normalizes empty and platform locale spellings', () => {
    expect(normalizeLocale(' IT_it ')).toBe('it-it')
    expect(normalizeLocale('')).toBe('en')
  })
})
