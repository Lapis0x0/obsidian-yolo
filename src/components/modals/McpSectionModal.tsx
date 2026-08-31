import { App } from 'obsidian'

import { SettingsProvider } from '../../contexts/settings-context'
import type YoloPlugin from '../../main'
import { ReactModal } from '../common/ReactModal'
import { McpSection } from '../settings/sections/McpSection'

type McpSectionComponentProps = {
  app: App
  plugin: YoloPlugin
}

export class McpSectionModal extends ReactModal<McpSectionComponentProps> {
  constructor(app: App, plugin: YoloPlugin) {
    super({
      app: app,
      Component: McpSectionComponent,
      props: {
        app,
        plugin,
      },
      plugin: plugin,
    })
    this.modalEl.classList.add('yolo-modal--wide')
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
