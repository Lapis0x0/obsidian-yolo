import React, {
  ReactNode,
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react'

import { localeStore } from '../core/i18n/localeStore'
import { Language, createTranslationFunction, loadLocale } from '../i18n'

const resolveLanguage = (rawLanguage: string): Language => {
  if (rawLanguage.startsWith('zh')) return 'zh'
  if (rawLanguage.startsWith('it')) return 'it'
  return 'en'
}

type LanguageContextType = {
  language: Language
  t: (keyPath: string, fallback?: string) => string
}

const LanguageContext = createContext<LanguageContextType | null>(null)

type LanguageProviderProps = {
  children: ReactNode
}

export function LanguageProvider({ children }: LanguageProviderProps) {
  const locale = useSyncExternalStore(
    localeStore.subscribe,
    localeStore.getSnapshot,
    localeStore.getSnapshot,
  ).locale
  const language = resolveLanguage(locale)
  const [, setTranslationRevision] = useState(0)

  useEffect(() => {
    let current = true
    void loadLocale(language).then(() => {
      if (current) setTranslationRevision((revision) => revision + 1)
    })
    return () => {
      current = false
    }
  }, [language])

  const t = createTranslationFunction(language)

  return (
    <LanguageContext.Provider
      value={{
        language,
        t,
      }}
    >
      {children}
    </LanguageContext.Provider>
  )
}

export function useLanguage(): LanguageContextType {
  const context = useContext(LanguageContext)
  if (!context) {
    throw new Error('useLanguage must be used within a LanguageProvider')
  }
  return context
}
