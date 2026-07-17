import type { App } from 'obsidian'
import React, { type ReactNode, createContext, useContext } from 'react'

import type { AnkiImportJournalStorage } from '../../core/learning/anki/ankiImportJournalStorage'
import type { AnkiWorkerHost } from '../../core/learning/anki/AnkiWorkerHost'
import type { AnkiRuntimeHost } from '../../core/learning/anki/runtime/AnkiRuntimeHost'
import type { LearningCardFileStore } from '../../core/learning/cardFile'
import type { LearningGenerationAgent } from '../../core/learning/generation/host'
import type {
  LearningNavigationHandler,
  LearningNavigationTarget,
} from '../../core/learning/learningNavigation'
import type { LearningStatsService } from '../../core/learning/learningStatsService'
import type { LearningVaultReadApi } from '../../core/learning/learningVaultReadApi'
import type { LearningVaultWriteApi } from '../../core/learning/learningVaultWriteApi'
import type { ProjectEventBus } from '../../core/learning/projectEventBus'
import type { LearningSrsStore } from '../../core/learning/srs/srsStore'

export type LearningLocale = 'en' | 'it' | 'zh'

export type LearningSettings = {
  learningBaseDir: string
  generationModelId: string
  fallbackModelId: string
}

export type LearningActionToast = {
  id: string
  tone: 'success' | 'warning' | 'error'
  title: string
  message: string
  actionLabel: string
  dismissLabel: string
  onAction: () => void | Promise<void>
}

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- This public host boundary is intentionally extensible.
export interface LearningUiHost {
  readonly app: App
  readonly vault: LearningVaultReadApi
  readonly vaultWriter: LearningVaultWriteApi
  readonly ankiImportJournalStorage: AnkiImportJournalStorage
  readonly ankiWorkerHost: AnkiWorkerHost
  readonly ankiRuntimeHost: AnkiRuntimeHost
  readonly settings: LearningSettings
  readonly locale: LearningLocale
  readonly t: (keyPath: string, fallback?: string) => string
  readonly srsStore: LearningSrsStore
  readonly statsService: LearningStatsService
  readonly cardFileStore: LearningCardFileStore
  readonly generationAgent: LearningGenerationAgent
  readonly isGenerationDebugEnabled: () => boolean
  subscribeSettings(listener: (settings: LearningSettings) => void): () => void
  setEventBus(bus: ProjectEventBus | null): void
  setNavigationHandler(handler: LearningNavigationHandler | null): void
  openLearningView(target?: LearningNavigationTarget): Promise<void>
  trackGeneration(controller: AbortController): void
  releaseGeneration(controller: AbortController): void
  showActionToast(toast: LearningActionToast): void
}

const LearningUiHostContext = createContext<LearningUiHost | null>(null)

export function LearningUiHostProvider({
  host,
  children,
}: {
  host: LearningUiHost
  children: ReactNode
}) {
  return (
    <LearningUiHostContext.Provider value={host}>
      {children}
    </LearningUiHostContext.Provider>
  )
}

export function useLearningUiHost(): LearningUiHost {
  const host = useContext(LearningUiHostContext)
  if (!host) {
    throw new Error(
      'useLearningUiHost must be used within a LearningUiHostProvider',
    )
  }
  return host
}

export function useLearningLanguage(): {
  locale: LearningLocale
  t: LearningUiHost['t']
} {
  const { locale, t } = useLearningUiHost()
  return { locale, t }
}
