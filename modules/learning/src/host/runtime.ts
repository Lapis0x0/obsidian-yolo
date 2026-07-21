import { createHostLearningVaultReadApi } from '../domain/hostVaultAdapter'
import { LearningRuntime } from '../domain/runtime/learningRuntime'
import type { LearningRuntimePorts } from '../domain/runtime/ports'
import { LearningSrsStore } from '../domain/srs/srsStore'
import { LearningStatsService } from '../domain/stats/learningStatsService'
import { createLearningTranslation } from '../i18n'

import { createHostLearningBackgroundPort } from './background'
import { createOwnerLearningLifecyclePorts } from './lifecycle'
import { type LearningHostSettings, createHostLearningSettings } from './paths'
import {
  type HostLearningSrsOptions,
  resolveHostLearningSrsStore,
} from './srsStorage'
import { createHostLearningProjectSource } from './stats'

type LearningRuntimeAdapterOptions = Readonly<{
  host: YoloModuleHostApiV1
  owner: Document | HTMLElement
  openLearningHome?: () => void
  translate?: (keyPath: string, fallback: string) => string
}> &
  HostLearningSrsOptions

export type HostLearningRuntimeAdapter = Readonly<{
  runtime: LearningRuntime<LearningSrsStore, LearningStatsService>
  settings: LearningHostSettings
  dispose(): void
}>

export function createHostLearningTranslation(
  host: Pick<YoloModuleHostApiV1, 'i18n'>,
): (keyPath: string, fallback: string) => string {
  return (keyPath, fallback) =>
    createLearningTranslation(host.i18n.getSnapshot().locale)(keyPath, fallback)
}

export function createHostLearningRuntimeAdapter({
  host,
  owner,
  openLearningHome,
  translate,
  srsStore,
  srsStorage,
}: LearningRuntimeAdapterOptions): HostLearningRuntimeAdapter {
  const settings = createHostLearningSettings(
    host.paths,
    host.settings,
    host.config,
  )
  const vault = createHostLearningVaultReadApi(host.vault)
  const lifecycle = createOwnerLearningLifecyclePorts(owner)
  const projects = createHostLearningProjectSource(vault, settings)
  const sharedSrsStore = resolveHostLearningSrsStore(host, {
    srsStore,
    srsStorage,
  })
  const translateLatest = translate ?? createHostLearningTranslation(host)
  const ports: LearningRuntimePorts<LearningSrsStore, LearningStatsService> = {
    createSrsStore: () => sharedSrsStore,
    createStatsService: (srsStore) =>
      new LearningStatsService({ vault, projects, srsStore, lifecycle }),
    background: createHostLearningBackgroundPort(host.background),
    openLearningHome,
    translate: translateLatest,
    clock: { now: Date.now },
  }
  const runtime = new LearningRuntime(ports)
  let learningBaseDir = settings.getSnapshot().learningBaseDir
  const unsubscribeSettings = settings.subscribe((snapshot) => {
    if (snapshot.learningBaseDir === learningBaseDir) return
    learningBaseDir = snapshot.learningBaseDir
    runtime.restartStats()
  })
  let disposed = false

  return Object.freeze({
    runtime,
    settings,
    dispose: () => {
      if (disposed) return
      disposed = true
      unsubscribeSettings()
      runtime.dispose()
    },
  })
}
