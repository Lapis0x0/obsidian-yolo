import { App } from 'obsidian'

import { LanguageProvider } from '../../contexts/language-context'
import { PluginProvider } from '../../contexts/plugin-context'
import { SettingsProvider } from '../../contexts/settings-context'
import SmartComposerPlugin from '../../main'

import { SettingsTabs } from './SettingsTabs'

type SettingsTabRootProps = {
  app: App
  plugin: SmartComposerPlugin
}

export function SettingsTabRoot({ app, plugin }: SettingsTabRootProps) {
  return (
    <PluginProvider plugin={plugin}>
      <LanguageProvider>
        <SettingsProvider
          settings={plugin.settings}
          setSettings={plugin.setSettings.bind(plugin)}
          addSettingsChangeListener={plugin.addSettingsChangeListener.bind(
            plugin,
          )}
        >
          <SettingsTabs app={app} plugin={plugin} />
        </SettingsProvider>
      </LanguageProvider>
    </PluginProvider>
  )
}
