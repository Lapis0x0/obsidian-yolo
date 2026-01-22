import type { SettingMigration, SmartComposerSettings } from '../setting.types'

const DEFAULT_QUICK_ASK_CONTEXT_BEFORE_CHARS = 5000
const DEFAULT_QUICK_ASK_CONTEXT_AFTER_CHARS = 2000

export const migrateFrom26To27: SettingMigration['migrate'] = (data) => {
  const newData = { ...data }
  newData.version = 27

  const continuationOptionsRaw = newData.continuationOptions
  const continuationOptions:
    | SmartComposerSettings['continuationOptions']
    | Record<string, unknown>
    | undefined =
    continuationOptionsRaw && typeof continuationOptionsRaw === 'object'
      ? (continuationOptionsRaw as Record<string, unknown>)
      : undefined

  if (!continuationOptions) {
    newData.continuationOptions = {
      quickAskContextBeforeChars: DEFAULT_QUICK_ASK_CONTEXT_BEFORE_CHARS,
      quickAskContextAfterChars: DEFAULT_QUICK_ASK_CONTEXT_AFTER_CHARS,
    }
    return newData
  }

  if (typeof continuationOptions.quickAskContextBeforeChars !== 'number') {
    continuationOptions.quickAskContextBeforeChars =
      DEFAULT_QUICK_ASK_CONTEXT_BEFORE_CHARS
  }
  if (typeof continuationOptions.quickAskContextAfterChars !== 'number') {
    continuationOptions.quickAskContextAfterChars =
      DEFAULT_QUICK_ASK_CONTEXT_AFTER_CHARS
  }

  newData.continuationOptions = continuationOptions
  return newData
}
