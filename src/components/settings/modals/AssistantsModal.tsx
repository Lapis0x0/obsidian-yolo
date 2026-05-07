import { App } from '../../../runtime/react-compat'
import React from 'react'

import { SettingsProvider } from '../../../contexts/settings-context'
import SmartComposerPlugin from '../../../main'
import { ReactModal } from '../../common/ReactModal'
import { AgentsSectionContent } from '../sections/AgentsSectionContent'

type AssistantsModalComponentProps = {
  app: App
  plugin: SmartComposerPlugin
  initialAssistantId?: string
  initialCreate?: boolean
}

export class AssistantsModal extends ReactModal<AssistantsModalComponentProps> {
  constructor(
    app: App,
    plugin: SmartComposerPlugin,
    initialAssistantId?: string,
    initialCreate?: boolean,
  ) {
    super({
      app: app,
      Component: AssistantsModalComponentWrapper,
      props: { app, plugin, initialAssistantId, initialCreate },
      options: {
        title:
          initialAssistantId || initialCreate
            ? undefined
            : plugin.t('settings.agent.agents', 'Agents'),
      },
      plugin: plugin,
    })
    this.modalEl.classList.add('smtcmp-modal--wide')
    if (initialAssistantId || initialCreate) {
      this.modalEl.classList.add('smtcmp-modal--agent-direct-edit')
    }
  }
}

function AssistantsModalComponentWrapper({
  app,
  plugin,
  initialAssistantId,
  initialCreate,
  onClose,
}: AssistantsModalComponentProps & { onClose: () => void }) {
  return (
    <SettingsProvider
      settings={plugin.settings}
      setSettings={(newSettings) => plugin.setSettings(newSettings)}
      addSettingsChangeListener={(listener) =>
        plugin.addSettingsChangeListener(listener)
      }
    >
      <AgentsSectionContent
        app={app}
        onClose={onClose}
        initialAssistantId={initialAssistantId}
        initialCreate={initialCreate}
      />
    </SettingsProvider>
  )
}
