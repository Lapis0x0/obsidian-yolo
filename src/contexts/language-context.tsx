import { getLanguage } from 'obsidian'
import React, {
  ReactNode,
  createContext,
  useContext,
  useEffect,
  useState,
} from 'react'

import { Language, createTranslationFunction } from '../i18n'

import { usePlugin } from './plugin-context'

type LanguageContextType = {
  language: Language
  t: (keyPath: string, fallback?: string) => string
}

const LanguageContext = createContext<LanguageContextType | null>(null)

type LanguageProviderProps = {
  children: ReactNode
}

export function LanguageProvider({ children }: LanguageProviderProps) {
  const plugin = usePlugin()
  const [languagePreference, setLanguagePreference] = useState<
    'auto' | Language
  >((plugin.settings.languagePreference as 'auto' | Language) || 'auto')
  const getObsidianLanguage = () => {
    const rawLanguage = getLanguage()
    const domLanguage =
      typeof document !== 'undefined'
        ? document.documentElement.lang || navigator.language || ''
        : ''
    const storedLanguage =
      typeof window !== 'undefined'
        ? window.localStorage.getItem('language') || ''
        : ''
    const candidates = [rawLanguage, domLanguage, storedLanguage]
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
    const normalized =
      candidates.find((value) => value !== 'en') ?? candidates[0] ?? 'en'
    if (normalized.startsWith('zh')) return 'zh'
    if (normalized.startsWith('it')) return 'it'
    return 'en'
  }
  const resolveLanguage = () => {
    if (languagePreference !== 'auto') {
      return languagePreference
    }
    return getObsidianLanguage()
  }
  const [language, setLanguageState] = useState<Language>(
    resolveLanguage(),
  )

  useEffect(() => {
    const updateLanguage = () => {
      setLanguageState(resolveLanguage())
    }
    updateLanguage()
  }, [languagePreference])

  useEffect(() => {
    const unsubscribe = plugin.addSettingsChangeListener((newSettings) => {
      const nextPreference = (newSettings.languagePreference as
        | 'auto'
        | Language
        | undefined) ?? 'auto'
      setLanguagePreference(nextPreference)
    })
    return unsubscribe
  }, [plugin])

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
