import { App } from 'obsidian'
import React, { type ComponentType } from 'react'

import { SettingsProvider } from '../../../contexts/settings-context'
import type YoloPlugin from '../../../main'
import { ReactModal } from '../../common/ReactModal'

type ContinuationQuickActionsModalComponentProps = {
  plugin: YoloPlugin
  Content: ComponentType
}

export class ContinuationQuickActionsModal extends ReactModal<ContinuationQuickActionsModalComponentProps> {
  constructor(app: App, plugin: YoloPlugin, Content: ComponentType) {
    super({
      app: app,
      Component: ContinuationQuickActionsModalComponentWrapper,
      props: { plugin, Content },
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
  Content,
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
      <Content />
    </SettingsProvider>
  )
}
