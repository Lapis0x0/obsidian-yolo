import { App } from 'obsidian'
import React from 'react'

import { SettingsProvider } from '../../../contexts/settings-context'
import YoloPlugin from '../../../main'
import { ReactModal } from '../../common/ReactModal'
import { SmartSpaceQuickActionsSettingsContent } from '../SmartSpaceQuickActionsSettings'

type SmartSpaceQuickActionsModalComponentProps = {
  plugin: YoloPlugin
}

export class SmartSpaceQuickActionsModal extends ReactModal<SmartSpaceQuickActionsModalComponentProps> {
  constructor(app: App, plugin: YoloPlugin) {
    super({
      app: app,
      Component: SmartSpaceQuickActionsModalComponentWrapper,
      props: { plugin },
      options: {
        title: plugin.t(
          'settings.smartSpace.quickActionsModalTitle',
          'Quick Ask continuation presets',
        ),
      },
      plugin: plugin,
    })
    this.modalEl.classList.add('yolo-modal--wide')
  }
}

function SmartSpaceQuickActionsModalComponentWrapper({
  plugin,
  onClose: _onClose,
}: SmartSpaceQuickActionsModalComponentProps & { onClose: () => void }) {
  return (
    <SettingsProvider
      settings={plugin.settings}
      setSettings={(newSettings) => plugin.setSettings(newSettings)}
      addSettingsChangeListener={(listener) =>
        plugin.addSettingsChangeListener(listener)
      }
    >
      <SmartSpaceQuickActionsSettingsContent />
    </SettingsProvider>
  )
}
