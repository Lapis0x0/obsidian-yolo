import { App } from 'obsidian'
import React from 'react'

import { SettingsProvider } from '../../../contexts/settings-context'
import SmartComposerPlugin from '../../../main'
import { ReactModal } from '../../common/ReactModal'
import { SmartSpaceQuickActionsSettingsContent } from '../SmartSpaceQuickActionsSettings'

type SmartSpaceQuickActionsModalComponentProps = {
  plugin: SmartComposerPlugin
}

export class SmartSpaceQuickActionsModal extends ReactModal<SmartSpaceQuickActionsModalComponentProps> {
  constructor(app: App, plugin: SmartComposerPlugin) {
    super({
      app: app,
      Component: SmartSpaceQuickActionsModalComponentWrapper,
      props: { plugin },
      options: {
        title: 'Smart space quick actions',
      },
      plugin: plugin,
    })
    this.modalEl.classList.add('smtcmp-modal--wide')
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
