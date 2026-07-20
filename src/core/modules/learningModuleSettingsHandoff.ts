import type {
  ModuleCreateIfAbsentResult,
  ModuleDataEnvelope,
} from './moduleSettingsStore'

const LEARNING_MODULE_ID = 'learning'

export type ModuleConfigCreateIfAbsent = (
  moduleId: string,
  envelope: ModuleDataEnvelope,
) => Promise<ModuleCreateIfAbsentResult>

/** Seeds the module's migration input without claiming or replacing its config. */
export function handoffLearningLegacySettings(
  createIfAbsent: ModuleConfigCreateIfAbsent,
  legacy: unknown,
): Promise<ModuleCreateIfAbsentResult> {
  const raw =
    legacy && typeof legacy === 'object'
      ? (legacy as Record<string, unknown>)
      : {}
  const data: Record<string, unknown> = {}
  if (raw.modelId !== undefined) data.modelId = raw.modelId
  if (raw.betaNoticeAcknowledged !== undefined) {
    data.betaNoticeAcknowledged = raw.betaNoticeAcknowledged
  }
  return createIfAbsent(LEARNING_MODULE_ID, {
    schemaVersion: 0,
    data,
  })
}
