import type {
  ModuleCreateIfAbsentResult,
  ModuleDataEnvelope,
} from './moduleSettingsStore'

const LEARNING_MODULE_ID = 'learning'

export type LearningLegacySettings = Readonly<{
  modelId: unknown
  betaNoticeAcknowledged: unknown
}>

export type ModuleConfigCreateIfAbsent = (
  moduleId: string,
  envelope: ModuleDataEnvelope,
) => Promise<ModuleCreateIfAbsentResult>

/** Seeds the module's migration input without claiming or replacing its config. */
export function handoffLearningLegacySettings(
  createIfAbsent: ModuleConfigCreateIfAbsent,
  legacy: LearningLegacySettings,
): Promise<ModuleCreateIfAbsentResult> {
  return createIfAbsent(LEARNING_MODULE_ID, {
    schemaVersion: 0,
    data: {
      modelId: legacy.modelId,
      betaNoticeAcknowledged: legacy.betaNoticeAcknowledged,
    },
  })
}
