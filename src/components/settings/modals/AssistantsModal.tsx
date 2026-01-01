import { App } from 'obsidian'
import React from 'react'

import { SettingsProvider } from '../../../contexts/settings-context'
import SmartComposerPlugin from '../../../main'
import { ReactModal } from '../../common/ReactModal'
import { AssistantsSectionContent } from '../sections/AssistantsSection'

type AssistantsModalComponentProps = {
  app: App
  plugin: SmartComposerPlugin
}

export class AssistantsModal extends ReactModal<AssistantsModalComponentProps> {
  constructor(app: App, plugin: SmartComposerPlugin) {
    super({
      app: app,
      Component: AssistantsModalComponentWrapper,
      props: { app, plugin },
      options: {
        title: 'Assistants',
      },
      plugin: plugin,
    })
    this.modalEl.classList.add('smtcmp-modal--wide')
  }
}

function AssistantsModalComponentWrapper({
  app,
  plugin,
  onClose: _onClose,
}: AssistantsModalComponentProps & { onClose: () => void }) {
  return (
    <SettingsProvider
      settings={plugin.settings}
      setSettings={(newSettings) => plugin.setSettings(newSettings)}
      addSettingsChangeListener={(listener) =>
        plugin.addSettingsChangeListener(listener)
      }
    >
      <AssistantsSectionContent app={app} />
    </SettingsProvider>
  )
}
