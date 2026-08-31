import { App } from 'obsidian'
import React from 'react'

import { SettingsProvider } from '../../../contexts/settings-context'
import type YoloPlugin from '../../../main'
import { ReactModal } from '../../common/ReactModal'
import { AgentsSectionContent } from '../sections/AgentsSectionContent'

type AssistantsModalComponentProps = {
  app: App
  plugin: YoloPlugin
  initialAssistantId?: string
  initialCreate?: boolean
}

export class AssistantsModal extends ReactModal<AssistantsModalComponentProps> {
  constructor(
    app: App,
    plugin: YoloPlugin,
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
    this.modalEl.classList.add('yolo-modal--wide')
    if (initialAssistantId || initialCreate) {
      this.modalEl.classList.add('yolo-modal--agent-direct-edit')
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
