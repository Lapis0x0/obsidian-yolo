import { App } from 'obsidian'

import { LanguageProvider, useLanguage } from '../../contexts/language-context'
import { PluginProvider } from '../../contexts/plugin-context'
import { SettingsProvider } from '../../contexts/settings-context'
import SmartComposerPlugin from '../../main'
import { ObsidianButton } from '../common/ObsidianButton'
import { ObsidianSetting } from '../common/ObsidianSetting'

import { AssistantsSection } from './sections/AssistantsSection'
import { ChatPreferencesSection } from './sections/ChatPreferencesSection'
import { ContinuationSection } from './sections/ContinuationSection'
import { DefaultModelsAndPromptsSection } from './sections/DefaultModelsAndPromptsSection'
import { EtcSection } from './sections/EtcSection'
import { McpSection } from './sections/McpSection'
import { ProvidersAndModelsSection } from './sections/ProvidersAndModelsSection'
import { RAGSection } from './sections/RAGSection'

type SettingsTabRootProps = {
  app: App
  plugin: SmartComposerPlugin
}

function SettingsContent({ app, plugin }: SettingsTabRootProps) {
  const { t } = useLanguage()

  return (
    <>
      <ObsidianSetting
        name={t('settings.supportSmartComposer.name')}
        desc={t('settings.supportSmartComposer.desc')}
        heading
        className="smtcmp-settings-support-smart-composer"
      >
        <ObsidianButton
          text={t('settings.supportSmartComposer.buyMeACoffee')}
          onClick={() => window.open('https://afdian.com/a/lapis0x0', '_blank')}
          cta
        />
      </ObsidianSetting>
      <ProvidersAndModelsSection app={app} plugin={plugin} />
      <DefaultModelsAndPromptsSection />
      <ChatPreferencesSection />
      <AssistantsSection app={app} />
      <RAGSection app={app} plugin={plugin} />
      <McpSection app={app} plugin={plugin} />
      <ContinuationSection app={app} />
      <EtcSection app={app} plugin={plugin} />
    </>
  )
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
          <SettingsContent app={app} plugin={plugin} />
        </SettingsProvider>
      </LanguageProvider>
    </PluginProvider>
  )
}
