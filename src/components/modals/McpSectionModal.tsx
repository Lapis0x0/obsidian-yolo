import { App } from '../../runtime/react-compat'

import { SettingsProvider } from '../../contexts/settings-context'
import SmartComposerPlugin from '../../main'
import { ReactModal } from '../common/ReactModal'
import { McpSection } from '../settings/sections/McpSection'

type McpSectionComponentProps = {
  app: App
  plugin: SmartComposerPlugin
}

export class McpSectionModal extends ReactModal<McpSectionComponentProps> {
  constructor(app: App, plugin: SmartComposerPlugin) {
    super({
      app: app,
      Component: McpSectionComponent,
      props: {
        app,
        plugin,
      },
      plugin: plugin,
    })
    this.modalEl.classList.add('smtcmp-modal--wide')
  }
}

function McpSectionComponent({
  app,
  plugin,
  onClose: _onClose,
}: McpSectionComponentProps & { onClose: () => void }) {
  return (
    <SettingsProvider
      settings={plugin.settings}
      setSettings={(newSettings) => plugin.setSettings(newSettings)}
      addSettingsChangeListener={(listener) =>
        plugin.addSettingsChangeListener(listener)
      }
    >
      <McpSection app={app} plugin={plugin} />
    </SettingsProvider>
  )
}
