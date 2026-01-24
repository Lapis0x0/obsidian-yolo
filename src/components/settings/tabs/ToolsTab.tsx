import { App } from 'obsidian'
import React from 'react'

import SmartComposerPlugin from '../../../main'
import { McpSection } from '../sections/McpSection'

type ToolsTabProps = {
  app: App
  plugin: SmartComposerPlugin
}

export function ToolsTab({ app, plugin }: ToolsTabProps) {
  return (
    <>
      <McpSection app={app} plugin={plugin} />
    </>
  )
}
