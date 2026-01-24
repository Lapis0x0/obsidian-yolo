import { App } from 'obsidian'
import React from 'react'

import SmartComposerPlugin from '../../../main'
import { AssistantsSection } from '../sections/AssistantsSection'
import { ChatPreferencesSection } from '../sections/ChatPreferencesSection'

type ChatTabProps = {
  app: App
  plugin: SmartComposerPlugin
}

export function ChatTab({ app }: ChatTabProps) {
  return (
    <>
      <ChatPreferencesSection />
      <AssistantsSection app={app} />
    </>
  )
}
