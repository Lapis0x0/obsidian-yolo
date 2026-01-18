import { getLanguage } from 'obsidian'
import React, {
  ReactNode,
  createContext,
  useContext,
  useEffect,
  useState,
} from 'react'

import { Language, createTranslationFunction } from '../i18n'

const resolveObsidianLanguage = (): Language => {
  const rawLanguage = String(getLanguage() ?? '')
    .trim()
    .toLowerCase()
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
  const resolveLanguage = () => resolveObsidianLanguage()
  const [language, setLanguageState] = useState<Language>(resolveLanguage)

  useEffect(() => {
    const updateLanguage = () => {
      setLanguageState(resolveLanguage())
    }
    updateLanguage()
  }, [])

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
