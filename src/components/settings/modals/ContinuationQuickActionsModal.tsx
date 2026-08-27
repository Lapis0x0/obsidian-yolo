import { App } from 'obsidian'
import React from 'react'

import { SettingsProvider } from '../../../contexts/settings-context'
import YoloPlugin from '../../../main'
import { ReactModal } from '../../common/ReactModal'
import { ContinuationQuickActionsSettingsContent } from '../ContinuationQuickActionsSettings'

type ContinuationQuickActionsModalComponentProps = {
  plugin: YoloPlugin
}

export class ContinuationQuickActionsModal extends ReactModal<ContinuationQuickActionsModalComponentProps> {
  constructor(app: App, plugin: YoloPlugin) {
    super({
      app: app,
      Component: ContinuationQuickActionsModalComponentWrapper,
      props: { plugin },
      options: {
        title: plugin.t(
          'settings.continuationQuickActions.quickActionsModalTitle',
          'Quick Ask continuation presets',
        ),
      },
      plugin: plugin,
    })
    this.modalEl.classList.add('yolo-modal--wide')
  }
}

function ContinuationQuickActionsModalComponentWrapper({
  plugin,
  onClose: _onClose,
}: ContinuationQuickActionsModalComponentProps & { onClose: () => void }) {
  return (
    <SettingsProvider
      settings={plugin.settings}
      setSettings={(newSettings) => plugin.setSettings(newSettings)}
      addSettingsChangeListener={(listener) =>
        plugin.addSettingsChangeListener(listener)
      }
    >
      <ContinuationQuickActionsSettingsContent />
    </SettingsProvider>
  )
}
