import type { App } from 'obsidian'

/** Opens Obsidian Settings → Community plugins (built-in update channel). */
export function openCommunityPluginsSettings(app: App): void {
  // @ts-expect-error: setting property exists in Obsidian's App but is not typed
  app.setting.open()
  // @ts-expect-error: setting property exists in Obsidian's App but is not typed
  app.setting.openTabById('community-plugins')
}
