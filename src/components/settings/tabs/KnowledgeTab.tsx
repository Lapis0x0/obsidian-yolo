import { App } from 'obsidian'
import React from 'react'

import type YoloPlugin from '../../../main'
import { RAGSection } from '../sections/RAGSection'

type KnowledgeTabProps = {
  app: App
  plugin: YoloPlugin
}

export function KnowledgeTab({ app, plugin }: KnowledgeTabProps) {
  return (
    <>
      <RAGSection app={app} plugin={plugin} />
    </>
  )
}
