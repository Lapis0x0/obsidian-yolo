type HostPaths = YoloModuleHostApiV1['paths']
type HostSettings = YoloModuleHostApiV1['settings']
type HostConfig = YoloModuleHostApiV1['config']

const LEARNING_DIR_NAME = 'learning'

export const LEARNING_MANAGED_DATA_NAMESPACE = 'managed-data'

export function runWithLearningManagedDataLock<T>(
  paths: Pick<HostPaths, 'runExclusive'>,
  operation: () => T | PromiseLike<T>,
): Promise<T> {
  return paths.runExclusive(LEARNING_MANAGED_DATA_NAMESPACE, operation)
}

export type LearningHostSettingsSnapshot = Readonly<{
  baseDir: string
  learningBaseDir: string
  config: ReturnType<HostConfig['getSnapshot']>
  models: YoloModuleHostModelSnapshotV1
}>

export type LearningHostSettings = Readonly<{
  getSnapshot(): LearningHostSettingsSnapshot
  subscribe(
    listener: (snapshot: LearningHostSettingsSnapshot) => void,
  ): () => void
}>

export function getBaseDirFromContentRoot(contentRoot: string): string {
  const normalized = normalizeVaultPath(contentRoot)
  const suffix = `/${LEARNING_DIR_NAME}`
  if (!normalized.endsWith(suffix)) {
    throw new Error(`Invalid Learning content root: ${contentRoot}`)
  }
  return normalized.slice(0, -suffix.length)
}

export function createHostLearningSettings(
  paths: HostPaths,
  settings: HostSettings,
  config: HostConfig,
): LearningHostSettings {
  const getSnapshot = (): LearningHostSettingsSnapshot => {
    const learningBaseDir = normalizeVaultPath(paths.getSnapshot().contentRoot)
    return Object.freeze({
      baseDir: getBaseDirFromContentRoot(learningBaseDir),
      learningBaseDir,
      config: config.getSnapshot(),
      models: settings.getModelSnapshot(),
    })
  }

  return Object.freeze({
    getSnapshot,
    subscribe: (listener) => {
      let subscribed = true
      let previous = getSnapshot()
      const publish = (): void => {
        if (!subscribed) return
        const next = getSnapshot()
        if (sameSnapshot(previous, next)) return
        previous = next
        listener(next)
      }
      const unsubscribePaths = paths.subscribe(publish)
      const unsubscribeModels = settings.subscribeModels(publish)
      const unsubscribeConfig = config.subscribe(publish)
      return () => {
        if (!subscribed) return
        subscribed = false
        unsubscribePaths()
        unsubscribeModels()
        unsubscribeConfig()
      }
    },
  })
}

export function normalizeVaultPath(path: string): string {
  const segments: string[] = []
  for (const segment of path.trim().replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) throw new Error(`Invalid vault path: ${path}`)
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  if (segments.length === 0) throw new Error(`Invalid vault path: ${path}`)
  return segments.join('/')
}

function sameSnapshot(
  left: LearningHostSettingsSnapshot,
  right: LearningHostSettingsSnapshot,
): boolean {
  if (
    left.baseDir !== right.baseDir ||
    left.learningBaseDir !== right.learningBaseDir ||
    left.config !== right.config ||
    left.models.defaultModelId !== right.models.defaultModelId ||
    left.models.models.length !== right.models.models.length
  ) {
    return false
  }
  return left.models.models.every((model, index) => {
    const other = right.models.models[index]
    return (
      model.id === other?.id &&
      model.name === other.name &&
      model.providerId === other.providerId
    )
  })
}
