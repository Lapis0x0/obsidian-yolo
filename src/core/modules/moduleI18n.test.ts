import { LocaleStore } from '../i18n/localeStore'

import { ModuleLifecycleScope } from './lifecycleScope'
import {
  ModuleI18nCapabilityProvider,
  resolveLocalizedText,
  snapshotLocalizedText,
} from './moduleI18n'

describe('module i18n capability', () => {
  it('shares stable snapshots and revokes listeners with lifecycle disposal', () => {
    let locale = 'en'
    const store = new LocaleStore({ readLocale: () => locale })
    const lifecycle = new ModuleLifecycleScope()
    const capability = new ModuleI18nCapabilityProvider(store).create(
      'learning',
      lifecycle,
    ).api
    const listener = jest.fn()
    capability.subscribe(listener)
    const initial = capability.getSnapshot()

    store.refresh()
    expect(capability.getSnapshot()).toBe(initial)
    locale = 'zh-CN'
    store.refresh()
    expect(capability.getSnapshot()).toEqual({ locale: 'zh-cn' })
    expect(listener).toHaveBeenCalledTimes(1)

    lifecycle.dispose()
    locale = 'it'
    store.refresh()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('copies localized text and resolves locale, language, then English fallback', () => {
    const source = { en: 'Name', zh: '名称' }
    const snapshot = snapshotLocalizedText(source, 'Name')
    source.zh = 'Changed'
    expect(resolveLocalizedText(snapshot, 'zh-CN')).toBe('名称')
    expect(resolveLocalizedText(snapshot, 'it')).toBe('Name')
    expect(Object.isFrozen(snapshot)).toBe(true)
  })
})
