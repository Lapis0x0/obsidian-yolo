import { App } from 'obsidian'

import type { SettingsTabId } from '../components/settings/SettingsTabs'
import type YoloPlugin from '../main'

export const SETTINGS_ACTIVE_TAB_STORAGE_KEY = 'yolo_settings_active_tab'

/**
 * Opens the plugin settings with a specific tab pre-selected. `SettingsTabs`
 * reads the stored tab id on mount, so it has to be written before opening.
 */
export const openPluginSettingsTab = (
  app: App,
  plugin: YoloPlugin,
  tabId: SettingsTabId,
): void => {
  void app.saveLocalStorage(SETTINGS_ACTIVE_TAB_STORAGE_KEY, tabId)
  // @ts-expect-error: setting property exists in Obsidian's App but is not typed
  app.setting.open()
  // @ts-expect-error: setting property exists in Obsidian's App but is not typed
  app.setting.openTabById(plugin.manifest.id)
}
