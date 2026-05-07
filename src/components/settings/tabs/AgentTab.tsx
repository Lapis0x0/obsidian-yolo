import { App } from '../../../runtime/react-compat'
import React from 'react'

import SmartComposerPlugin from '../../../main'
import { AgentSection } from '../sections/AgentSection'

type AgentTabProps = {
  app: App
  plugin: SmartComposerPlugin
}

export function AgentTab({ app }: AgentTabProps) {
  return <AgentSection app={app} />
}
