import type { App } from 'obsidian'

export type UniqueNoteConfig = {
  enabled: boolean
  folder: string
  format: string
}

const DEFAULT_UNIQUE_NOTE_FORMAT = 'YYYYMMDDHHmmss'

export function readUniqueNoteConfig(app: App): UniqueNoteConfig | null {
  const internalPlugins = app.internalPlugins
  if (!internalPlugins) return null

  const plugin =
    internalPlugins.getPluginById?.('unique-note') ??
    internalPlugins.plugins?.['unique-note']
  if (!plugin) return null

  const enabled = Boolean(plugin.enabled ?? plugin._loaded)
  const options = plugin.instance?.options ?? {}

  const folderValue = options.folder
  const formatValue = options.format

  return {
    enabled,
    folder: typeof folderValue === 'string' ? folderValue : '',
    format:
      typeof formatValue === 'string' && formatValue.length > 0
        ? formatValue
        : DEFAULT_UNIQUE_NOTE_FORMAT,
  }
}
