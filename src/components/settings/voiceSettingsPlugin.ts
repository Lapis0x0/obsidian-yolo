import type { YoloSettings } from '../../settings/schema/setting.types'

/**
 * Voice settings only need persisted settings access. Keeping this boundary
 * narrow avoids pulling the plugin entrypoint back into settings leaf modules.
 */
export type VoiceSettingsPlugin = {
  settings: YoloSettings
  setSettings(settings: YoloSettings): Promise<boolean>
}
