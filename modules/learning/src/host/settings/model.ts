type HostConfig = YoloModuleHostApiV1['config']
type HostSettings = YoloModuleHostApiV1['settings']

export const LEARNING_SETTINGS_SCHEMA_VERSION = 1

export type LearningSettingsSnapshot = Readonly<{
  modelId: string
  betaNoticeAcknowledged: boolean
}>

/**
 * The exact schema-zero payload Core may seed from its legacy learningOptions.
 * The module never reads the legacy Core settings object itself.
 */
export type LearningSettingsMigrationInput = Readonly<{
  modelId: unknown
  betaNoticeAcknowledged: unknown
}>

export type LearningSettingsModel = Readonly<{
  getSnapshot(): LearningSettingsSnapshot
  subscribe(listener: () => void): () => void
  setModelId(modelId: string): Promise<void>
  acknowledgeBetaNotice(): Promise<void>
  dispose(): void
}>

export type LearningSettingsModelOptions = Readonly<{
  config: HostConfig
  settings: HostSettings
  onError?: (error: unknown) => void
}>

export async function createLearningSettingsModel({
  config,
  settings,
  onError,
}: LearningSettingsModelOptions): Promise<LearningSettingsModel> {
  let disposed = false
  let configSnapshot = config.getSnapshot()
  let source = readConfig(configSnapshot)
  let models = settings.getModelSnapshot()
  let snapshot = resolveSnapshot(source, models)
  let needsRepair = !isCanonicalConfig(configSnapshot, snapshot)
  let queue = Promise.resolve()
  const listeners = new Set<() => void>()
  const reportError = (error: unknown): void => {
    try {
      onError?.(error)
    } catch {
      // Error reporting is outside the settings model's ownership boundary.
    }
  }
  const assertActive = (): void => {
    if (disposed) throw new Error('Learning settings model is disposed')
  }
  const publish = (next: LearningSettingsSnapshot): void => {
    if (disposed || sameSettings(snapshot, next)) return
    snapshot = next
    for (const listener of [...listeners]) {
      if (disposed) break
      try {
        listener()
      } catch (error) {
        reportError(error)
      }
    }
  }
  const persist = (
    update: (current: LearningSettingsSnapshot) => LearningSettingsSnapshot,
  ): Promise<void> => {
    if (disposed) {
      return Promise.reject(new Error('Learning settings model is disposed'))
    }
    const result = queue
      .catch(() => undefined)
      .then(async () => {
        assertActive()
        const current = resolveSnapshot(source, models)
        const next = normalizeSnapshot(update(current), models)
        const persisted = await config.replace({
          schemaVersion: LEARNING_SETTINGS_SCHEMA_VERSION,
          data: next,
        })
        assertActive()
        configSnapshot = persisted
        source = readConfig(persisted)
        needsRepair = !isCanonicalConfig(
          configSnapshot,
          resolveSnapshot(source, models),
        )
        publish(resolveSnapshot(source, models))
      })
    queue = result.catch(() => undefined)
    return result
  }
  const reconcile = (): void => {
    const next = resolveSnapshot(source, models)
    publish(next)
    if (!needsRepair && sameSettings(source, next)) return
    void persist(() => next).catch(reportError)
  }

  if (needsRepair) {
    const persisted = await config.replace({
      schemaVersion: LEARNING_SETTINGS_SCHEMA_VERSION,
      data: snapshot,
    })
    configSnapshot = persisted
    source = readConfig(persisted)
    snapshot = resolveSnapshot(source, models)
    needsRepair = !isCanonicalConfig(configSnapshot, snapshot)
  }

  const unsubscribeConfig = config.subscribe(() => {
    if (disposed) return
    try {
      configSnapshot = config.getSnapshot()
      source = readConfig(configSnapshot)
      needsRepair = !isCanonicalConfig(
        configSnapshot,
        resolveSnapshot(source, models),
      )
      reconcile()
    } catch (error) {
      reportError(error)
    }
  })
  const unsubscribeModels = settings.subscribeModels(() => {
    if (disposed) return
    try {
      models = settings.getModelSnapshot()
      reconcile()
    } catch (error) {
      reportError(error)
    }
  })

  try {
    configSnapshot = config.getSnapshot()
    source = readConfig(configSnapshot)
    models = settings.getModelSnapshot()
    needsRepair = !isCanonicalConfig(
      configSnapshot,
      resolveSnapshot(source, models),
    )
    reconcile()
  } catch (error) {
    unsubscribeModels()
    unsubscribeConfig()
    throw error
  }

  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      assertActive()
      if (typeof listener !== 'function') {
        throw new TypeError('Learning settings listener must be a function')
      }
      listeners.add(listener)
      let subscribed = true
      return () => {
        if (!subscribed) return
        subscribed = false
        listeners.delete(listener)
      }
    },
    setModelId: (modelId) => {
      if (typeof modelId !== 'string') {
        return Promise.reject(
          new TypeError('Learning model id must be a string'),
        )
      }
      return persist((current) => ({ ...current, modelId }))
    },
    acknowledgeBetaNotice: () =>
      persist((current) => ({ ...current, betaNoticeAcknowledged: true })),
    dispose: () => {
      if (disposed) return
      disposed = true
      listeners.clear()
      unsubscribeModels()
      unsubscribeConfig()
    },
  })
}

function readConfig(
  snapshot: ReturnType<HostConfig['getSnapshot']>,
): LearningSettingsSnapshot {
  if (
    snapshot.schemaVersion !== 0 &&
    snapshot.schemaVersion !== LEARNING_SETTINGS_SCHEMA_VERSION
  ) {
    throw new Error(
      `Unsupported Learning settings schema version: ${String(snapshot.schemaVersion)}`,
    )
  }
  const data = isRecord(snapshot.data) ? snapshot.data : {}
  return Object.freeze({
    modelId: typeof data.modelId === 'string' ? data.modelId : '',
    betaNoticeAcknowledged:
      typeof data.betaNoticeAcknowledged === 'boolean'
        ? data.betaNoticeAcknowledged
        : false,
  })
}

function resolveSnapshot(
  source: LearningSettingsSnapshot,
  models: YoloModuleHostModelSnapshotV1,
): LearningSettingsSnapshot {
  return normalizeSnapshot(source, models)
}

function normalizeSnapshot(
  source: LearningSettingsSnapshot,
  models: YoloModuleHostModelSnapshotV1,
): LearningSettingsSnapshot {
  const available = new Set(models.models.map((model) => model.id))
  const fallback = available.has(models.defaultModelId)
    ? models.defaultModelId
    : (models.models[0]?.id ?? '')
  return Object.freeze({
    modelId: available.has(source.modelId) ? source.modelId : fallback,
    betaNoticeAcknowledged: source.betaNoticeAcknowledged,
  })
}

function sameSettings(
  left: LearningSettingsSnapshot,
  right: LearningSettingsSnapshot,
): boolean {
  return (
    left.modelId === right.modelId &&
    left.betaNoticeAcknowledged === right.betaNoticeAcknowledged
  )
}

function isCanonicalConfig(
  snapshot: ReturnType<HostConfig['getSnapshot']>,
  resolved: LearningSettingsSnapshot,
): boolean {
  if (
    snapshot.schemaVersion !== LEARNING_SETTINGS_SCHEMA_VERSION ||
    !isRecord(snapshot.data)
  ) {
    return false
  }
  const keys = Object.keys(snapshot.data)
  return (
    keys.length === 2 &&
    keys.includes('modelId') &&
    keys.includes('betaNoticeAcknowledged') &&
    snapshot.data.modelId === resolved.modelId &&
    snapshot.data.betaNoticeAcknowledged === resolved.betaNoticeAcknowledged
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
