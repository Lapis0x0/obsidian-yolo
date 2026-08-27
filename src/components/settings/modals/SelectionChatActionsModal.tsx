import { App } from 'obsidian'
import React, { type ComponentType } from 'react'

import { SettingsProvider } from '../../../contexts/settings-context'
import type YoloPlugin from '../../../main'
import { ReactModal } from '../../common/ReactModal'

type SelectionChatActionsModalComponentProps = {
  plugin: YoloPlugin
  Content: ComponentType
}

export class SelectionChatActionsModal extends ReactModal<SelectionChatActionsModalComponentProps> {
  constructor(app: App, plugin: YoloPlugin, Content: ComponentType) {
    super({
      app: app,
      Component: SelectionChatActionsModalComponentWrapper,
      props: { plugin, Content },
      options: {
        title: plugin.t(
          'settings.selectionChat.quickActionsTitle',
          'Cursor Chat quick actions',
        ),
      },
      plugin: plugin,
    })
    this.modalEl.classList.add('yolo-modal--wide')
  }
}

function SelectionChatActionsModalComponentWrapper({
  plugin,
  Content,
  onClose: _onClose,
}: SelectionChatActionsModalComponentProps & { onClose: () => void }) {
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
