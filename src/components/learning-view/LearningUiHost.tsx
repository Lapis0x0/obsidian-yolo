import type { App } from 'obsidian'
import React, { type ReactNode, createContext, useContext } from 'react'

import type { LearningGenerationAgent } from '../../core/learning/generation/host'
import type {
  LearningNavigationHandler,
  LearningNavigationTarget,
} from '../../core/learning/learningNavigation'
import type { LearningStatsService } from '../../core/learning/learningStatsService'
import type { ProjectEventBus } from '../../core/learning/projectEventBus'
import type { LearningSrsStore } from '../../core/learning/srs/srsStore'
import type { YoloSettings } from '../../settings/schema/setting.types'
import type { ActionToastOptions } from '../ActionToast'

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- This public host boundary is intentionally extensible.
export interface LearningUiHost {
  readonly app: App
  readonly settings: YoloSettings
  readonly t: (keyPath: string, fallback?: string) => string
  readonly srsStore: LearningSrsStore
  readonly statsService: LearningStatsService
  readonly generationAgent: LearningGenerationAgent
  readonly runtimeIdentity: {
    pluginId: string
    pluginDir?: string
  }
  setSettings(settings: YoloSettings): void | Promise<void>
  subscribeSettings(listener: (settings: YoloSettings) => void): () => void
  setEventBus(bus: ProjectEventBus | null): void
  setNavigationHandler(handler: LearningNavigationHandler | null): void
  openLearningView(target?: LearningNavigationTarget): Promise<void>
  trackGeneration(controller: AbortController): void
  releaseGeneration(controller: AbortController): void
  showActionToast(toast: ActionToastOptions): void
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
