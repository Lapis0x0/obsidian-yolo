import { App } from 'obsidian'
import React from 'react'

import SmartComposerPlugin from '../../../main'
import { RAGSection } from '../sections/RAGSection'

type KnowledgeTabProps = {
  app: App
  plugin: SmartComposerPlugin
}

export function KnowledgeTab({ app, plugin }: KnowledgeTabProps) {
  return (
    <>
      <RAGSection app={app} plugin={plugin} />
    </>
  )
}
